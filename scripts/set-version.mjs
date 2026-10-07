// Sets the version of all published packages and the @belay/* ranges that depend on them.
// Usage: npm run set-version -- 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run set-version -- <version>');
  process.exit(1);
}

const published = ['core', 'web', 'calibrate'].map((dir) => `packages/${dir}/package.json`);
for (const file of [...published, 'examples/package.json']) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (published.includes(file)) pkg.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith('@belay/')) pkg[field][name] = `^${version}`;
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Set @belay/* to ${version}. Run npm install to update package-lock.json.`);
