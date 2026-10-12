const fs = require("node:fs");
const path = require("node:path");

exports.waitForGate = async (stage) => {
  const root = process.env.SPECWRIGHT_NATIVE_PROGRESS_ROOT;
  if (!root) {return;}
  const release = path.join(root, `release-${stage}`);
  fs.writeFileSync(path.join(root, `${stage}-ready`), "ready");
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (fs.existsSync(release)) {clearInterval(poll); clearTimeout(timeout); resolve();}
    }, 20);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Progress acceptance gate ${stage} was not released`));
    }, 60_000);
  });
};
