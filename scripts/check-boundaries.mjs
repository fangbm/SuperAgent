import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const inside = (file, directory) => file === directory || file.startsWith(directory + path.sep);

export function checkBoundaries(root = defaultRoot) {
  const errors = [];
  const packages = walk(path.join(root, 'packages')).filter(f => path.basename(f) === 'package.json').map(file => ({
    file, directory: path.dirname(file), manifest: JSON.parse(readFileSync(file, 'utf8')),
  }));
  for (const pkg of packages) {
    const name = pkg.manifest.name;
    if (pkg.manifest.private !== true) errors.push(`${name}: package must remain private`);
    const dependencies = Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies, ...pkg.manifest.peerDependencies, ...pkg.manifest.optionalDependencies });
    const contracts = name === '@superagent/contracts';
    const sdk = name === '@superagent/plugin-sdk';
    const core = name === '@superagent/agent-core';
    const domain = name === '@superagent/domain';
    const connector = inside(pkg.directory, path.join(root, 'packages', 'connectors')) || inside(pkg.directory, path.join(root, 'packages', 'delivery-plugins'));
    const forbidden = target =>
      (contracts && true) ||
      (sdk && target !== '@superagent/contracts') ||
      (connector && /(?:persistence|domain|agent-core|plugin-host)/.test(target)) ||
      (core && /(?:connectors|delivery-plugins|qq|discord|steam)/.test(target)) ||
      (domain && /(?:connectors|delivery-plugins|qq|discord|steam)/.test(target));
    for (const dependency of dependencies) if (forbidden(dependency)) errors.push(`${name}: forbidden dependency ${dependency}`);
    for (const file of walk(path.join(pkg.directory, 'src')).filter(f => /\.[cm]?[jt]s$/.test(f))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        let specifier;
        let typeOnly = false;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
          typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
          specifier = node.argument.literal.text;
          typeOnly = true;
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
          specifier = node.moduleReference.expression.text;
          typeOnly = node.isTypeOnly;
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
          else if (contracts || sdk || connector || core || domain) errors.push(`${name}: computed module import in ${path.relative(root, file)}`);
        }
        if (specifier) {
          let targetName = specifier;
          if (specifier.startsWith('.')) {
            const resolved = path.resolve(path.dirname(file), specifier);
            const target = packages.find(candidate => inside(resolved, candidate.directory));
            if (target && target !== pkg) {
              errors.push(`${name}: cross-package relative import ${specifier}`);
              targetName = target.manifest.name;
            } else if (inside(resolved, pkg.directory)) targetName = undefined;
          }
          if (targetName && forbidden(targetName)) errors.push(`${name}: forbidden import ${specifier}`);
          if (targetName?.startsWith('@superagent/')) {
            const packageName = targetName.split('/').slice(0, 2).join('/');
            if (!dependencies.includes(packageName)) errors.push(`${name}: undeclared dependency ${packageName}`);
            if (/\/(?:src|dist|internal)(?:\/|$)/.test(targetName)) errors.push(`${name}: internal package import ${specifier}`);
          }
          if (sdk && !typeOnly) errors.push(`${name}: SDK must use type-only imports/exports`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (rootManifest.private !== true) errors.push('workspace must remain private');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('PASS: workspace privacy and package dependency boundaries');
}
