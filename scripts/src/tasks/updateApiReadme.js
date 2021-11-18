// @ts-check
const babelParser = require("@babel/parser");
const {
  isExportNamedDeclaration,
  isFunctionDeclaration,
  isIdentifier,
} = require("@babel/types");
const { DocExcerpt, TSDocParser } = require("@microsoft/tsdoc");
const fs = require("fs");
const glob = require("glob");
const path = require("path");

const README = "README.md";
const TOKEN_START = "<!-- @rnx-kit/api start -->";
const TOKEN_END = "<!-- @rnx-kit/api end -->";

/**
 * @param {string} summary
 * @returns {string}
 */
function extractBrief(summary) {
  const newParagraph = summary.indexOf("\n\n");
  return (newParagraph > 0 ? summary.substring(0, newParagraph) : summary)
    .trim()
    .replace(/\n/g, " ");
}

/**
 * @param {readonly import("@babel/types").Comment[] | null} comments
 * @returns {import("@babel/types").Comment | null}
 */
function findLastBlockComment(comments) {
  if (comments) {
    for (let i = comments.length - 1; i >= 0; --i) {
      if (comments[i].type === "CommentBlock") {
        return comments[i];
      }
    }
  }
  return null;
}

/**
 * @returns {string[]}
 */
function findSourceFiles() {
  try {
    const tsconfig = require.resolve("./tsconfig.json", {
      paths: [process.cwd()],
    });
    const { include } = require(tsconfig);
    if (Array.isArray(include)) {
      return include.reduce((result, pattern) => {
        if (fs.existsSync(pattern)) {
          if (fs.statSync(pattern).isDirectory()) {
            result.push(...glob.sync(`${pattern}/**/*.ts`));
          } else {
            result.push(pattern);
          }
        } else {
          result.push(...glob.sync(pattern));
        }
        return result;
      }, /** @type {string[]} */ ([]));
    }
  } catch (_) {
    /* ignore */
  }
  return [];
}

/**
 * @param {import("@babel/types").ExportNamedDeclaration} node
 * @returns {string}
 */
function getExportedName(node) {
  switch (node.declaration?.type) {
    case "FunctionDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
      if (!isIdentifier(node.declaration.id)) {
        // TODO: Unnamed functions are currently unsupported
        return "";
      }
      return node.declaration.id.name;
    default:
      return "";
  }
}

/**
 * @param {import("@microsoft/tsdoc").DocNode} docNode
 * @returns {string}
 */
function renderDocNode(docNode) {
  /** @type {string[]} */
  const content = [];
  if (docNode) {
    if (docNode instanceof DocExcerpt) {
      content.push(docNode.content.toString());
    }
    docNode.getChildNodes().forEach((childNode) => {
      content.push(renderDocNode(childNode));
    });
  }
  return content.join("");
}

/**
 * @param {import("@babel/types").LVal} node
 * @returns {string}
 */
function renderParamNode(node) {
  switch (node.type) {
    case "ArrayPattern":
      return "[]";
    case "AssignmentPattern":
      return renderParamNode(node.left);
    case "Identifier":
      return node.name;
    case "MemberExpression":
      throw new Error(`Unsupported parameter type: ${node.type}`);
    case "ObjectPattern":
      return "{}";
    case "RestElement":
      return `...${renderParamNode(node.argument)}`;
    case "TSParameterProperty":
      throw new Error(`Unsupported parameter type: ${node.type}`);
  }
}

/**
 * @param {[string, string, string][]} exportedTypes
 * @param {[string, string, string][]} exportedFunctions
 */
function updateReadme(exportedTypes, exportedFunctions) {
  /** @type {(lhs: [string, string, string], rhs: [string, string, string]) => -1 | 0 | 1} */
  const sortByCategory = (lhs, rhs) => {
    if (lhs[0] !== rhs[0]) {
      return lhs[0] < rhs[0] ? -1 : 1;
    }
    return lhs[1] === rhs[1] ? 0 : lhs[1] < rhs[1] ? -1 : 1;
  };

  /** @type {(table: string[][], options?: {}) => string} */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const markdownTable = require("markdown-table");

  const types =
    exportedTypes.length === 0
      ? ""
      : markdownTable([
          ["Category", "Type Name", "Description"],
          ...exportedTypes.sort(sortByCategory),
        ]);

  const functions =
    exportedFunctions.length === 0
      ? ""
      : markdownTable([
          ["Category", "Function", "Description"],
          ...exportedFunctions.sort(sortByCategory),
        ]);

  const readme = fs.readFileSync(README, { encoding: "utf-8" });
  const updatedReadme = readme.replace(
    new RegExp(`${TOKEN_START}([^]+)${TOKEN_END}`),
    `${TOKEN_START}\n\n${[types, functions]
      .filter(Boolean)
      .join("\n\n")}\n\n${TOKEN_END}`
  );

  if (updatedReadme !== readme) {
    fs.writeFileSync(README, updatedReadme);
  }
}

function updateApiReadme() {
  const tsdocParser = new TSDocParser();

  /** @type {[string, string, string][]} */
  const exportedFunctions = [];

  /** @type {[string, string, string][]} */
  const exportedTypes = [];

  findSourceFiles().forEach((file) => {
    const category = path.basename(file, ".ts");
    const content = fs.readFileSync(file, { encoding: "utf-8" });
    babelParser
      .parse(content, {
        plugins: ["typescript"],
        sourceType: "module",
        sourceFilename: file,
      })
      .program.body.forEach((node) => {
        if (!isExportNamedDeclaration(node)) {
          return;
        }

        const name = getExportedName(node);
        if (!name) {
          return;
        }

        const identifier = (() => {
          if (isFunctionDeclaration(node.declaration)) {
            return `\`${name}(${node.declaration.params
              .map(renderParamNode)
              .join(", ")})\``;
          }
          return name;
        })();

        const commentBlock = findLastBlockComment(node.leadingComments);
        if (!commentBlock) {
          console.warn(
            "WARN",
            `${file}:`,
            `${identifier} is exported but undocumented`
          );
          return;
        }

        const result = tsdocParser.parseString(
          "/*" + commentBlock.value + "*/"
        );
        const summary = renderDocNode(result.docComment.summarySection);
        const description = extractBrief(summary);

        if (isFunctionDeclaration(node.declaration)) {
          exportedFunctions.push([category, identifier, description]);
        } else {
          exportedTypes.push([category, identifier, description]);
        }
      });
  });

  updateReadme(exportedTypes, exportedFunctions);
}

exports.updateApiReadme = updateApiReadme;