import syncFs, { promises as fs, constants as fsConstants } from "fs";

import os from "os";

import path from "path";

import { pipeline } from "stream/promises";

import stream from "stream";

import { EventEmitter } from "events";

import chalk from "chalk";

import { NdjsonToMessageStream } from "@cucumber/message-streams";

import * as messages from "@cucumber/messages";

import detectCiEnvironment from "@cucumber/ci-environment";

import split from "split";

import { HOOK_FAILURE_EXPR } from "./constants";

import {
  ITaskSpecEnvelopes,
  ITaskCreateStringAttachment,
  ITaskTestCaseStarted,
  ITaskTestStepStarted,
  ITaskTestStepFinished,
  ITaskTestCaseFinished,
} from "./cypress-task-definitions";

import { resolve as origResolve } from "./preprocessor-configuration";

import { ensureIsAbsolute } from "./helpers/paths";

import { createTimestamp } from "./helpers/messages";

import { memoize } from "./helpers/memoize";

import debug from "./helpers/debug";

import { CypressCucumberError, createError, homepage } from "./helpers/error";

import { assert, assertAndReturn, assertIsString } from "./helpers/assertions";

import {
  createHtmlStream,
  createJsonFormatter,
  createPrettyFormatter,
} from "./helpers/formatters";

import { useColors } from "./helpers/colors";

import { notNull } from "./helpers/type-guards";

import { version as packageVersion } from "./version";

import { IStepHookParameter } from "./public-member-types";

const resolve = memoize(origResolve);

interface PrettyDisabled {
  enabled: false;
}

interface PrettyEnabled {
  enabled: true;
  broadcaster: EventEmitter;
  writable: stream.Writable;
}

type PrettyState = PrettyDisabled | PrettyEnabled;

interface StateInitial {
  state: "initial";
}

interface StateBeforeSpec {
  state: "before-spec";
  pretty: PrettyState;
}

interface StateReceivedSpecEnvelopes {
  state: "received-envelopes";
  pretty: PrettyState;
  messages: messages.Envelope[];
}

interface StateTestStarted {
  state: "test-started";
  pretty: PrettyState;
  messages: messages.Envelope[];
  testCaseStartedId: string;
}

interface StateStepStarted {
  state: "step-started";
  pretty: PrettyState;
  messages: messages.Envelope[];
  testCaseStartedId: string;
  testStepStartedId: string;
}

interface StateStepFinished {
  state: "step-finished";
  pretty: PrettyState;
  messages: messages.Envelope[];
  testCaseStartedId: string;
}

interface StateTestFinished {
  state: "test-finished";
  pretty: PrettyState;
  messages: messages.Envelope[];
}

interface StateAfterSpec {
  state: "after-spec";
}

type State =
  | StateInitial
  | StateBeforeSpec
  | StateReceivedSpecEnvelopes
  | StateTestStarted
  | StateStepStarted
  | StateStepFinished
  | StateTestFinished
  | StateAfterSpec;

let state: State = {
  state: "initial",
};

const isFeature = (spec: Cypress.Spec) => spec.name.endsWith(".feature");

const end = (stream: stream.Writable) =>
  new Promise<void>((resolve) => stream.end(resolve));

const createPrettyStream = () => {
  const line = split();

  const indent = new stream.Transform({
    objectMode: true,
    transform(chunk, _, callback) {
      callback(null, chunk.length === 0 ? "" : "  " + chunk);
    },
  });

  const log = new stream.Writable({
    write(chunk, _, callback) {
      console.log(chunk.toString("utf8"));
      callback();
    },
  });

  return stream.compose(line, indent, log);
};

const createStateError = (stateHandler: string, currentState: State["state"]) =>
  new CypressCucumberError(
    `Unexpected state in ${stateHandler}: ${currentState}. This almost always means that you or some other plugin, are overwriting this plugin's event handlers. For more information & workarounds, see https://github.com/badeball/cypress-cucumber-preprocessor/blob/master/docs/event-handlers.md (if neither workaround work, please report at ${homepage})`
  );

export async function beforeRunHandler(config: Cypress.PluginConfigOptions) {
  debug("beforeRunHandler()");

  if (!config.isTextTerminal) {
    return;
  }

  const preprocessor = await resolve(config, config.env, "/");

  if (!preprocessor.messages.enabled) {
    return;
  }

  const messagesPath = ensureIsAbsolute(
    config.projectRoot,
    preprocessor.messages.output
  );

  await fs.rm(messagesPath, { force: true });

  // Copied from https://github.com/cucumber/cucumber-js/blob/v10.0.1/src/cli/helpers.ts#L104-L122.
  const meta: messages.Envelope = {
    meta: {
      protocolVersion: messages.version,
      implementation: {
        version: packageVersion,
        name: "@badeball/cypress-cucumber-preprocessor",
      },
      cpu: {
        name: os.arch(),
      },
      os: {
        name: os.platform(),
        version: os.release(),
      },
      runtime: {
        name: "node.js",
        version: process.versions.node,
      },
      ci: detectCiEnvironment(process.env),
    },
  };

  const testRunStarted: messages.Envelope = {
    testRunStarted: {
      timestamp: createTimestamp(),
    },
  };

  await fs.mkdir(path.dirname(messagesPath), { recursive: true });

  await fs.writeFile(
    messagesPath,
    JSON.stringify(meta) + "\n" + JSON.stringify(testRunStarted) + "\n"
  );
}

export async function afterRunHandler(config: Cypress.PluginConfigOptions) {
  debug("afterRunHandler()");

  if (!config.isTextTerminal) {
    return;
  }

  const preprocessor = await resolve(config, config.env, "/");

  if (
    !preprocessor.messages.enabled &&
    !preprocessor.json.enabled &&
    !preprocessor.html.enabled
  ) {
    return;
  }

  const messagesPath = ensureIsAbsolute(
    config.projectRoot,
    preprocessor.messages.output
  );

  try {
    await fs.access(messagesPath, fsConstants.F_OK);
  } catch {
    return;
  }

  if (preprocessor.messages.enabled) {
    const testRunFinished: messages.Envelope = {
      testRunFinished: {
        /**
         * We're missing a "success" attribute here, but cucumber-js doesn't output it, so I won't.
         * Mostly because I don't want to look into the semantics of it right now.
         */
        timestamp: createTimestamp(),
      } as messages.TestRunFinished,
    };

    await fs.writeFile(messagesPath, JSON.stringify(testRunFinished) + "\n", {
      flag: "a",
    });
  }

  if (preprocessor.json.enabled) {
    const jsonPath = ensureIsAbsolute(
      config.projectRoot,
      preprocessor.json.output
    );

    await fs.mkdir(path.dirname(jsonPath), { recursive: true });

    const messages = (await fs.readFile(messagesPath))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    let jsonOutput: string | undefined;

    const eventBroadcaster = createJsonFormatter(messages, (chunk) => {
      jsonOutput = chunk;
    });

    for (const message of messages) {
      eventBroadcaster.emit("envelope", message);
    }

    assertIsString(
      jsonOutput,
      "Expected JSON formatter to have finished, but it never returned"
    );

    await fs.writeFile(jsonPath, jsonOutput);
  }

  if (preprocessor.html.enabled) {
    const htmlPath = ensureIsAbsolute(
      config.projectRoot,
      preprocessor.html.output
    );

    await fs.mkdir(path.dirname(htmlPath), { recursive: true });

    const input = syncFs.createReadStream(messagesPath);

    const output = syncFs.createWriteStream(htmlPath);

    await pipeline(
      input,
      new NdjsonToMessageStream(),
      createHtmlStream(),
      output
    );
  }
}

export async function beforeSpecHandler(
  config: Cypress.PluginConfigOptions,
  spec: Cypress.Spec
) {
  debug("beforeSpecHandler()");

  if (!config.isTextTerminal || !isFeature(spec)) {
    return;
  }

  const preprocessor = await resolve(config, config.env, "/");

  if (!preprocessor.messages.enabled && !preprocessor.pretty.enabled) {
    return;
  }

  switch (state.state) {
    case "initial":
    case "after-spec":
      {
        if (preprocessor.pretty.enabled) {
          const writable = createPrettyStream();

          const eventBroadcaster = createPrettyFormatter(useColors(), (chunk) =>
            writable.write(chunk)
          );

          state = {
            state: "before-spec",
            pretty: {
              enabled: true,
              broadcaster: eventBroadcaster,
              writable,
            },
          };
        } else {
          state = {
            state: "before-spec",
            pretty: {
              enabled: false,
            },
          };
        }
      }
      break;
    // This happens in case of visting a new domain, ref. https://github.com/cypress-io/cypress/issues/26300.
    // In this case, we want to disgard messages obtained in the current test and allow execution to continue
    // as if nothing happened.
    case "before-spec":
    case "step-started":
      break;
    default:
      throw createStateError("beforeSpecHandler", state.state);
  }
}

export async function afterSpecHandler(
  config: Cypress.PluginConfigOptions,
  spec: Cypress.Spec,
  results: CypressCommandLine.RunResult
) {
  debug("afterSpecHandler()");

  if (!config.isTextTerminal || !isFeature(spec)) {
    return;
  }

  const preprocessor = await resolve(config, config.env, "/");

  const messagesPath = ensureIsAbsolute(
    config.projectRoot,
    preprocessor.messages.output
  );

  // `results` is undefined when running via `cypress open`.
  if (preprocessor.messages.enabled && results) {
    const wasRemainingSkipped = results.tests.some((test) =>
      test.displayError?.match(HOOK_FAILURE_EXPR)
    );

    if (wasRemainingSkipped) {
      console.log(
        chalk.yellow(
          `  Hook failures can't be represented in any reports (messages / json / html), thus none is created for ${spec.relative}.`
        )
      );
    } else if ("messages" in state) {
      await fs.writeFile(
        messagesPath,
        state.messages.map((message) => JSON.stringify(message)).join("\n") +
          "\n",
        {
          flag: "a",
        }
      );
    }
  }

  if ("pretty" in state && state.pretty.enabled) {
    await end(state.pretty.writable);
  }

  state = {
    state: "after-spec",
  };
}

export async function afterScreenshotHandler(
  config: Cypress.PluginConfigOptions,
  details: Cypress.ScreenshotDetails
) {
  debug("afterScreenshotHandler()");

  if (!config.isTextTerminal) {
    return details;
  }

  const preprocessor = await resolve(config, config.env, "/");

  if (!preprocessor.messages.enabled) {
    return details;
  }

  switch (state.state) {
    case "step-started":
      break;
    default:
      return details;
  }

  let buffer;

  try {
    buffer = await fs.readFile(details.path);
  } catch {
    return details;
  }

  const message: messages.Envelope = {
    attachment: {
      testCaseStartedId: state.testCaseStartedId,
      testStepId: state.testStepStartedId,
      body: buffer.toString("base64"),
      mediaType: "image/png",
      contentEncoding:
        "BASE64" as unknown as messages.AttachmentContentEncoding.BASE64,
    },
  };

  state.messages.push(message);

  return details;
}

export async function specEnvelopesHandler(
  config: Cypress.PluginConfigOptions,
  data: ITaskSpecEnvelopes
) {
  debug("specEnvelopesHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  switch (state.state) {
    case "before-spec":
      break;
    // This happens in case of visting a new domain, ref. https://github.com/cypress-io/cypress/issues/26300.
    // In this case, we want to disgard messages obtained in the current test and allow execution to continue
    // as if nothing happened.
    case "step-started":
      {
        const iTestCaseStarted = state.messages.findLastIndex(
          (message) => !!message.testCaseStarted
        );

        if (iTestCaseStarted === -1) {
          throw createError("Expected to find a testCaseStarted envelope");
        }

        let pretty: PrettyState;

        if (state.pretty.enabled) {
          await end(state.pretty.writable);

          console.log("  Reloading..");
          console.log();

          const writable = createPrettyStream();

          const eventBroadcaster = createPrettyFormatter(useColors(), (chunk) =>
            writable.write(chunk)
          );

          for (const message of data.messages) {
            eventBroadcaster.emit("envelope", message);
          }

          pretty = {
            enabled: true,
            writable,
            broadcaster: eventBroadcaster,
          };
        } else {
          pretty = state.pretty;
        }

        state = {
          state: "received-envelopes",
          pretty,
          messages: state.messages.slice(0, iTestCaseStarted),
        };
      }
      return true;
    default:
      throw createStateError("specEnvelopesHandler", state.state);
  }

  if (state.pretty.enabled) {
    for (const message of data.messages) {
      state.pretty.broadcaster.emit("envelope", message);
    }
  }

  state = {
    state: "received-envelopes",
    pretty: state.pretty,
    messages: data.messages,
  };

  return true;
}

export function testCaseStartedHandler(
  config: Cypress.PluginConfigOptions,
  data: ITaskTestCaseStarted
) {
  debug("testCaseStartedHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  switch (state.state) {
    case "received-envelopes":
    case "test-finished":
      break;
    default:
      throw createStateError("testCaseStartedHandler", state.state);
  }

  if (state.pretty.enabled) {
    state.pretty.broadcaster.emit("envelope", {
      testCaseStarted: data,
    });
  }

  state = {
    state: "test-started",
    pretty: state.pretty,
    messages: state.messages.concat({ testCaseStarted: data }),
    testCaseStartedId: data.id,
  };

  return true;
}

export function testStepStartedHandler(
  config: Cypress.PluginConfigOptions,
  data: ITaskTestStepStarted
) {
  debug("testStepStartedHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  switch (state.state) {
    case "test-started":
    case "step-finished":
      break;
    // This state can happen in cases where an error is "rescued".
    case "step-started":
      break;
    default:
      throw createStateError("testStepStartedHandler", state.state);
  }

  if (state.pretty.enabled) {
    state.pretty.broadcaster.emit("envelope", {
      testStepStarted: data,
    });
  }

  state = {
    state: "step-started",
    pretty: state.pretty,
    messages: state.messages.concat({ testStepStarted: data }),
    testCaseStartedId: state.testCaseStartedId,
    testStepStartedId: data.testStepId,
  };

  return true;
}

export type Attach = (data: string | Buffer, mediaType?: string) => void;

export type OnAfterStep = (
  options: {
    attach: Attach;
    result: messages.TestStepResult;
  } & IStepHookParameter
) => Promise<void> | void;

export async function testStepFinishedHandler(
  config: Cypress.PluginConfigOptions,
  options: { onAfterStep?: OnAfterStep },
  testStepFinished: ITaskTestStepFinished
) {
  debug("testStepFinishedHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  switch (state.state) {
    case "step-started":
      break;
    default:
      throw createStateError("testStepFinishedHandler", state.state);
  }

  if (state.pretty.enabled) {
    state.pretty.broadcaster.emit("envelope", {
      testStepFinished,
    });
  }

  const { testCaseStartedId, testStepId } = testStepFinished;

  const { testCaseId: pickleId } = assertAndReturn(
    state.messages
      .map((message) => message.testCaseStarted)
      .filter(notNull)
      .find((testCaseStarted) => testCaseStarted.id === testCaseStartedId),
    "Expected to find a testCaseStarted"
  );

  const testCase = assertAndReturn(
    state.messages
      .map((message) => message.testCase)
      .filter(notNull)
      .find((testCase) => testCase.id === pickleId),
    "Expected to find a testCase"
  );

  const { pickleStepId, hookId } = assertAndReturn(
    testCase.testSteps.find((testStep) => testStep.id === testStepId),
    "Expected to find a testStep"
  );

  if (pickleStepId != null) {
    const pickle = assertAndReturn(
      state.messages
        .map((message) => message.pickle)
        .filter(notNull)
        .find((pickle) => pickle.id === pickleId),
      "Expected to find a pickle"
    );

    const pickleStep = assertAndReturn(
      pickle.steps.find((step) => step.id === pickleStepId),
      "Expected to find a pickleStep"
    );

    const gherkinDocument = assertAndReturn(
      state.messages
        .map((message) => message.gherkinDocument)
        .filter(notNull)
        .find((gherkinDocument) => gherkinDocument.uri === pickle.uri),
      "Expected to find a gherkinDocument"
    );

    const attachments: ITaskCreateStringAttachment[] = [];

    await options.onAfterStep?.({
      result: testStepFinished.testStepResult,
      pickle,
      pickleStep,
      gherkinDocument,
      testCaseStartedId,
      testStepId,
      attach(data, mediaType) {
        if (typeof data === "string") {
          mediaType = mediaType ?? "text/plain";

          if (mediaType.startsWith("base64:")) {
            attachments.push({
              data,
              mediaType: mediaType.replace("base64:", ""),
              encoding: messages.AttachmentContentEncoding.BASE64,
            });
          } else {
            attachments.push({
              data,
              mediaType: mediaType ?? "text/plain",
              encoding: messages.AttachmentContentEncoding.IDENTITY,
            });
          }
        } else if (data instanceof Buffer) {
          if (typeof mediaType !== "string") {
            throw Error("Buffer attachments must specify a media type");
          }

          attachments.push({
            data: data.toString("base64"),
            mediaType,
            encoding: messages.AttachmentContentEncoding.BASE64,
          });
        } else {
          throw Error("Invalid attachment data: must be a Buffer or string");
        }
      },
    });

    for (const attachment of attachments) {
      await createStringAttachmentHandler(config, attachment);
    }
  } else {
    assert(hookId != null, "Expected a hookId in absence of pickleStepId");
  }

  state = {
    state: "step-finished",
    pretty: state.pretty,
    messages: state.messages.concat({ testStepFinished }),
    testCaseStartedId: state.testCaseStartedId,
  };

  return true;
}

export function testCaseFinishedHandler(
  config: Cypress.PluginConfigOptions,
  data: ITaskTestCaseFinished
) {
  debug("testCaseFinishedHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  switch (state.state) {
    case "test-started":
    case "step-finished":
      break;
    default:
      throw createStateError("testCaseFinishedHandler", state.state);
  }

  if (state.pretty.enabled) {
    state.pretty.broadcaster.emit("envelope", {
      testCaseFinished: data,
    });
  }

  state = {
    state: "test-finished",
    pretty: state.pretty,
    messages: state.messages.concat({ testCaseFinished: data }),
  };

  return true;
}

export async function createStringAttachmentHandler(
  config: Cypress.PluginConfigOptions,
  { data, mediaType, encoding }: ITaskCreateStringAttachment
) {
  debug("createStringAttachmentHandler()");

  if (!config.isTextTerminal) {
    return true;
  }

  const preprocessor = await resolve(config, config.env, "/");

  if (!preprocessor.messages.enabled) {
    return true;
  }

  switch (state.state) {
    case "step-started":
      break;
    default:
      throw createStateError("createStringAttachmentHandler", state.state);
  }

  const message: messages.Envelope = {
    attachment: {
      testCaseStartedId: state.testCaseStartedId,
      testStepId: state.testStepStartedId,
      body: data,
      mediaType: mediaType,
      contentEncoding: encoding,
    },
  };

  state.messages.push(message);

  return true;
}
