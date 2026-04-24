import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const workspaceRoot = process.cwd();

const bundles = [
  {
    label: 'runtime',
    directoryPath: path.join(workspaceRoot, 'media', 'injected', 'runtime'),
    extension: '.js',
    syntaxCheck: true
  },
  {
    label: 'styles',
    directoryPath: path.join(workspaceRoot, 'media', 'injected', 'styles'),
    extension: '.css',
    syntaxCheck: false
  }
];

for (const bundle of bundles) {
  const entryNames = readManifestEntries(bundle.directoryPath, bundle.extension);
  const actualEntryNames = readdirSync(bundle.directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === bundle.extension)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const missingEntries = entryNames.filter((entryName) => !actualEntryNames.includes(entryName));
  const extraEntries = actualEntryNames.filter((entryName) => !entryNames.includes(entryName));

  if (missingEntries.length > 0 || extraEntries.length > 0) {
    const details = [
      missingEntries.length > 0 ? `missing: ${missingEntries.join(', ')}` : null,
      extraEntries.length > 0 ? `extra: ${extraEntries.join(', ')}` : null
    ].filter(Boolean).join('; ');
    throw new Error(`Injected ${bundle.label} manifest is out of sync (${details}).`);
  }

  if (bundle.syntaxCheck) {
    validateJavaScriptBundle(bundle.directoryPath, entryNames);
  }

  console.log(`Validated injected ${bundle.label} bundle (${entryNames.length} fragments).`);
}

function readManifestEntries(directoryPath, extension) {
  const manifestPath = path.join(directoryPath, 'bundle.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entryNames = manifest?.entries;

  if (!Array.isArray(entryNames) || entryNames.length === 0) {
    throw new Error(`Injected bundle manifest at ${manifestPath} must contain a non-empty entries array.`);
  }

  const seen = new Set();
  return entryNames.map((entryName) => {
    if (typeof entryName !== 'string' || entryName.trim().length === 0) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains an invalid entry name.`);
    }

    if (path.extname(entryName).toLowerCase() !== extension) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains ${entryName}, which does not match ${extension}.`);
    }

    if (seen.has(entryName)) {
      throw new Error(`Injected bundle manifest at ${manifestPath} contains a duplicate entry for ${entryName}.`);
    }

    seen.add(entryName);
    return entryName;
  });
}

function validateJavaScriptBundle(directoryPath, entryNames) {
  const bundleSource = entryNames
    .map((entryName) => readFileSync(path.join(directoryPath, entryName), 'utf8'))
    .join('\n\n');

  const tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'copilot-annotation-runtime-'));
  const tempBundlePath = path.join(tempDirectoryPath, 'bundle.js');

  try {
    writeFileSync(tempBundlePath, bundleSource, 'utf8');
    const result = spawnSync(process.execPath, ['--check', tempBundlePath], {
      encoding: 'utf8'
    });

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Unknown JavaScript syntax error.');
    }
  } finally {
    rmSync(tempDirectoryPath, { recursive: true, force: true });
  }
}