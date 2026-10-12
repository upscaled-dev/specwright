const { waitForGate } = require("./progress-gate.cjs");
module.exports = () => waitForGate("teardown");
