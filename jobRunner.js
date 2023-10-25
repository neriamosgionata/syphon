require("reflect-metadata");
const sourceMapSupport = require("source-map-support");
const { Ignitor } = require("@adonisjs/core/build/standalone");
const { workerData } = require("worker_threads");

sourceMapSupport.install({ handleUncaughtExceptions: false });

const kernel = new Ignitor(__dirname).kernel("unknown");

const run = async () => {
  await kernel.registerTsCompilerHook();
  await kernel.boot();
  await kernel.start();

  /** @type import('app/Services/Jobs/JobHelpers').RunJobFunction */
  const job = require(workerData.jobPath).default;

  return job();
};

run()
  .finally(() => kernel.hasBooted && kernel.application.isReady && kernel.close());
