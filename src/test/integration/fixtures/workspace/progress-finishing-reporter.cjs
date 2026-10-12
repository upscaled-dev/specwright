const { waitForGate } = require("./progress-gate.cjs");

module.exports = class ProgressFinishingReporter {
  printsToStdio() {return false;}
  async onExit() {await waitForGate("finishing");}
};
