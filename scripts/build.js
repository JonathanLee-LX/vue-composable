// based on https://github.com/vuejs/vue-next/blob/master/scripts/build.js

// TODO improve this file, based on the necessities, since this is basically copied and pasted from `vue-next` repo

const fs = require("fs-extra");
const path = require("path");
const assert = require("assert");
const execa = require("execa");
const chalk = require("chalk");
const { gzipSync } = require("zlib");
const { compress } = require("brotli");
const { targets: allTargets, fuzzyMatchTarget } = require("./utils");

const args = require("minimist")(process.argv.slice(2));
const targets = args._;
const formats = args.formats || args.f;
const devOnly = args.devOnly || args.d;
const prodOnly = !devOnly && (args.prodOnly || args.p);
const isRelease = args.release;
const buildTypes = args.t || args.types || isRelease || true;
const buildAllMatching = args.all || args.a;
const lean = args.lean || args.l;
const commit = execa.sync("git", ["rev-parse", "HEAD"]).stdout.slice(0, 7);
const buildTargets = targets.length > 0 ? targets : allTargets;
const version = args.version || 3;

function run() {
  return buildAll(buildTargets);
}

async function buildAll(targets, targetVersion = version) {
  //   return await Promise.all(targets.map(build));
  for (const target of targets) {
    await build(target, targetVersion);
  }
  checkAllSizes(targets);
}

async function build(target, targetVersion) {
  assert([2, 2.7, 3].includes(targetVersion));

  const mainPkg = require(path.resolve("package.json"));

  const pkgDir = path.resolve(`packages/${target}`);
  const pkg = require(`${pkgDir}/package.json`);
  const renameRestore = await apiRename(target, targetVersion);
  let packageRestore = () =>
    fs.writeJSON(`${pkgDir}/package.json`, pkg, { spaces: 2 });

  try {
    // only build published packages for release
    if (isRelease && pkg.private) {
      return;
    }
    const peerDependencies =
      targetVersion === 2 ? pkg.peerDependencies2 : pkg.peerDependencies3;

    const dependencies =
      pkg.dependencies && pkg.dependencies["vue-composable"]
        ? {
            ...pkg.dependencies,
            "vue-composable": `^${mainPkg.version}`,
          }
        : pkg.dependencies;

    pkg.peerDependencies = peerDependencies;
    pkg.dependencies = dependencies;

    await fs.writeFile(`${pkgDir}/package.json`, JSON.stringify(pkg, null, 2));

    // if building a specific format, do not remove dist.
    if (!formats) {
      await fs.remove(`${pkgDir}/dist/v${version}`);
    }

    const env =
      (pkg.buildOptions && pkg.buildOptions.env) ||
      (devOnly ? "development" : "production");

    try {
      await execa(
        "rollup",
        [
          "-c",
          "--environment",
          [
            `COMMIT:${commit}`,
            `NODE_ENV:${env}`,
            `TARGET:${target}`,
            formats ? `FORMATS:${formats}` : ``,
            buildTypes ? `TYPES:true` : ``,
            prodOnly ? `PROD_ONLY:true` : ``,
            `VERSION:${mainPkg.version}`,
            `VUE_VERSION:${targetVersion}`,
          ]
            .filter(Boolean)
            .join(","),
        ],
        { stdio: "inherit" }
      );
    } catch (e) {
      await renameRestore();
      await packageRestore();

      console.error("error", e);

      return process.exit(1);
    }

    if (buildTypes && pkg.types) {
      console.log();
      console.log(
        chalk.bold(chalk.yellow(`Rolling up type definitions for ${target}...`))
      );

      // build types
      const {
        Extractor,
        ExtractorConfig,
      } = require("@microsoft/api-extractor");

      const extractorConfigPath = path.resolve(
        pkgDir,
        `api-extractor.v${targetVersion}.json`
      );
      const extractorConfig =
        ExtractorConfig.loadFileAndPrepare(extractorConfigPath);
      const result = Extractor.invoke(extractorConfig, {
        localBuild: true,
        showVerboseMessages: true,
      });

      if (result.succeeded) {
        // concat additional d.ts to rolled-up dts (mostly for JSX)
        if (pkg.buildOptions && pkg.buildOptions.dts) {
          const dtsPath = path.resolve(pkgDir, pkg.types);
          const existing = await fs.readFile(dtsPath, "utf-8");
          const toAdd = await Promise.all(
            pkg.buildOptions.dts.map((file) => {
              return fs.readFile(path.resolve(pkgDir, file), "utf-8");
            })
          );
          await fs.writeFile(dtsPath, existing + "\n" + toAdd.join("\n"));
        }
        console.log(
          chalk.bold(chalk.green(`API Extractor completed successfully.`))
        );
      } else {
        console.error(
          `API Extractor completed with ${extractorResult.errorCount} errors` +
            ` and ${extractorResult.warningCount} warnings`
        );
        await renameRestore();
        await packageRestore();
        process.exitCode = 1;
      }

      await fs.remove(`${pkgDir}/dist/v${targetVersion}/packages`);
    }

    // clean files
    await removeFiles(`${pkgDir}/dist`);
    // copy the folder files
    await copyFolder(`${pkgDir}/dist/v${targetVersion}`, `${pkgDir}/dist`);
  } finally {
    // await restorePkg();
    await renameRestore();
    await packageRestore();
  }
}

function checkAllSizes(targets) {
  if (devOnly) {
    return;
  }
  console.log();
  for (const target of targets) {
    checkSize(target);
  }
  console.log();
}

const resolvePkgDir = (target) => path.resolve(`packages/${target}`);

function checkSize(target) {
  const pkgDir = path.resolve(`packages/${target}`);
  const esmProdBuild = `${pkgDir}/dist/${target}.global.prod.js`;
  if (fs.existsSync(esmProdBuild)) {
    const file = fs.readFileSync(esmProdBuild);
    const minSize = (file.length / 1024).toFixed(2) + "kb";
    const gzipped = gzipSync(file);
    const gzippedSize = (gzipped.length / 1024).toFixed(2) + "kb";
    const compressed = compress(file);
    const compressedSize = (compressed.length / 1024).toFixed(2) + "kb";
    console.log(
      `${chalk.gray(
        chalk.bold(target)
      )} min:${minSize} / gzip:${gzippedSize} / brotli:${compressedSize}`
    );
  }
}

async function apiRename(target, targetVersion) {
  assert([2, 2.7, 3].includes(targetVersion));

  const pkgDir = path.resolve(`packages/${target}`);
  // await fs.rename(`${pkgDir}/src/api.ts`, `${pkgDir}/src/api.N.ts`);
  await fs.copy(
    `${pkgDir}/src/api.${targetVersion}.ts`,
    `${pkgDir}/src/api.ts`,
    { overwrite: true }
  );

  const restore = async () => {
    await fs.copy(`${pkgDir}/src/api.3.ts`, `${pkgDir}/src/api.ts`, {
      overwrite: true,
    });
    // await fs.rename(`${pkgDir}/src/api.N.ts`, `${pkgDir}/src/api.ts`);
  };

  return restore;
}

async function removeFiles(from) {
  const stat = await fs.lstat(from);
  if (!stat.isDirectory()) {
    return;
  }
  const files = await fs.readdir(from);
  await Promise.all(
    files.map(async (x) => {
      const fp = path.join(from, x);
      const s = await fs.lstat(fp);
      if (!s.isFile()) return Promise.resolve();
      fs.remove(fp);
    })
  );
}

async function copyFolder(from, to) {
  const stat = await fs.lstat(from);
  if (!stat.isDirectory()) {
    return;
  }
  const files = await fs.readdir(from);
  await Promise.all(
    files.map(async (x) => {
      const fp = path.join(from, x);
      const s = await fs.lstat(fp);
      if (!s.isFile()) return Promise.resolve();
      fs.copyFile(path.join(from, x), path.join(to, x));
    })
  );
}

exports.buildTargets = buildTargets;
exports.buildAll = buildAll;
exports.run = run;
exports.build = build;
exports.resolvePkgDir = resolvePkgDir;
exports.removeFiles = removeFiles;
exports.copyFolder = copyFolder;

if (require.main === module) run();
