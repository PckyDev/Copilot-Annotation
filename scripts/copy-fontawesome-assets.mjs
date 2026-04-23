import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(workspaceRoot, 'node_modules', '@fortawesome', 'fontawesome-free');
const targetRoot = path.join(workspaceRoot, 'media', 'vendor', 'fontawesome');

if (!existsSync(sourceRoot)) {
  throw new Error('Font Awesome dependency is missing. Run npm install before packaging.');
}

mkdirSync(targetRoot, { recursive: true });
cpSync(path.join(sourceRoot, 'css', 'all.min.css'), path.join(targetRoot, 'all.min.css'));
cpSync(path.join(sourceRoot, 'webfonts'), path.join(targetRoot, 'webfonts'), {
  recursive: true,
  force: true
});