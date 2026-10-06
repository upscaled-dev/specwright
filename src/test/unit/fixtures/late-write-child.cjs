const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const [directory, lifetime, role] = process.argv.slice(2);
const marker = path.join(directory, "status.json");
const settled = path.join(directory, "settled");
const observed = path.join(directory, "ready-observed");

function record(value) {
  fs.writeFileSync(marker + ".part", JSON.stringify(value));
  fs.renameSync(marker + ".part", marker);
}

function errorDetails(error, fallbackCode = "FIXTURE_ERROR") {
  return { code: error?.code ?? fallbackCode, message: error?.message ?? String(error),
    ...(error?.syscall ? { syscall: error.syscall } : {}) };
}

if (role !== "grandchild") {
  // Keep the parent alive until the inherited pipe has carried the grandchild's ready output.
  // POSIX needs a separate group to survive the runner's completed-command cleanup.
  const child = cp.spawn(process.execPath, [__filename, directory, lifetime, "grandchild"], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    detached: process.platform !== "win32",
  });
  let ready = false;
  const fail = (phase, error, fallbackCode) => {
    const diagnostic = { phase, ...errorDetails(error, fallbackCode) };
    process.stderr.write(`Grandchild startup failed: ${JSON.stringify(diagnostic)}\n`);
    const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : undefined;
    if (!previous?.outcome) {record({ ...previous, pid: child.pid, ...diagnostic, outcome: "unexpected" });}
    child.kill();
    process.exitCode = 1;
  };
  const timeout = setTimeout(() => fail("waiting for readiness", new Error("readiness deadline elapsed"), "FIXTURE_READY_TIMEOUT"), Number(lifetime));
  child.once("error", (error) => {clearTimeout(timeout); fail("spawn", error);});
  child.once("exit", (code) => {
    clearTimeout(timeout);
    if (!ready) {fail("before readiness", new Error(`exited with code ${code} before readiness`), "FIXTURE_EARLY_EXIT");}
  });
  child.once("message", () => {
    ready = true;
    clearTimeout(timeout);
    child.disconnect();
    child.unref();
  });
} else {
  let phase = "stdout initialization";
  let handle;
  let poll;
  let finished = false;
  const finish = (outcome, error) => {
    if (finished) {return;}
    finished = true;
    clearInterval(poll);
    clearTimeout(timeout);
    record({ pid: process.pid, node: process.version, platform: process.platform, phase, handle, outcome,
      ...(error ? errorDetails(error, outcome === "timeout" ? "FIXTURE_TIMEOUT" : "FIXTURE_ERROR") : {}) });
    process.exit(outcome === "write-error" ? 0 : 1);
  };
  const timeout = setTimeout(() => finish("timeout", new Error(`deadline elapsed during ${phase}`)), Number(lifetime));
  process.on("uncaughtException", (error) => finish("unexpected", error));
  try {
    record({ pid: process.pid, phase });
    const stdout = process.stdout;
    stdout.on("error", (error) => finish(phase === "late write" ? "write-error" : "unexpected", error));
    phase = "handle probe";
    const fd = fs.fstatSync(1);
    handle = fd.isFIFO() ? "fifo" : fd.isSocket() ? "socket" : "other";
    phase = "ready write";
    stdout.write("ready\n", (error) => {
      if (error) {finish("unexpected", error); return;}
      phase = "waiting for observation";
      record({ pid: process.pid, phase, handle });
      poll = setInterval(() => {
        if (phase === "waiting for observation") {
          if (!fs.existsSync(observed)) {return;}
          phase = "waiting for settlement";
          record({ pid: process.pid, phase, handle });
          process.send({ ready: true });
          return;
        }
        if (!fs.existsSync(settled)) {return;}
        clearInterval(poll);
        phase = "late write";
        try {
          stdout.write("late", (error) => finish(error ? "write-error" : "written", error));
        } catch (error) {finish("write-error", error);}
      }, 50);
    });
  } catch (error) {finish("unexpected", error);}
}
