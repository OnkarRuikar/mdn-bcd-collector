//
// mdn-bcd-collector: scripts/add-new-bcd.ts
// Adds missing entries to BCD that have support in some browser version
//
// © Gooborg Studios, Google LLC
// See the LICENSE file for copyright details
//

import {Identifier} from "@mdn/browser-compat-data/types";

import path from "node:path";
import {execSync} from "node:child_process";

import fs from "fs-extra";
import esMain from "es-main";

import {BCD_DIR} from "../lib/constants.js";
import {getMissing} from "./find-missing-features.js";
import {main as updateBcd} from "./update-bcd.js";
import {namespaces as jsNamespaces} from "../test-builder/javascript.js";

const tests = await fs.readJson(new URL("../tests.json", import.meta.url));
const overrides = await fs.readJson(
  new URL("../custom/overrides.json", import.meta.url),
);

const {default: bcd} = await import(`${BCD_DIR}/index.js`);
const {orderFeatures} = await import(`${BCD_DIR}/scripts/fix/feature-order.js`);

const template = {
  __compat: {
    support: {
      chrome: {version_added: null},
      chrome_android: "mirror",
      edge: "mirror",
      firefox: {version_added: null},
      firefox_android: "mirror",
      ie: {version_added: false},
      oculus: "mirror",
      opera: "mirror",
      opera_android: "mirror",
      safari: {version_added: null},
      safari_ios: "mirror",
      samsunginternet_android: "mirror",
      webview_android: "mirror",
    },
    status: {experimental: true, standard_track: true, deprecated: false},
  },
};

/**
 * Recursively adds a new identifier to the data object.
 * @param ident - The array of identifier parts.
 * @param i - The current index in the identifier array.
 * @param data - The data object to add the identifier to.
 * @param obj - The object to assign to the final identifier part.
 * @returns The updated data object.
 */
export const recursiveAdd = (
  ident: string[],
  i: number,
  data: Identifier,
  obj: any,
): Identifier => {
  const part = ident[i];

  data[part] =
    i + 1 < ident.length
      ? recursiveAdd(ident, i + 1, part in data ? data[part] : {}, obj)
      : Object.assign({}, obj);

  return data;
};

/**
 * Checks if a string starts with a lowercase letter.
 * @param s - The string to check.
 * @returns True if the string starts with a lowercase letter, false otherwise.
 */
const startsWithLowerCase = (s: string): boolean => {
  return s[0] === s[0].toLowerCase();
};

/**
 * Checks if a string starts with an uppercase letter.
 * @param s - The string to check.
 * @returns True if the string starts with an uppercase letter, false otherwise.
 */
const startsWithUpperCase = (s: string): boolean => {
  return s[0] === s[0].toUpperCase();
};

/**
 * Returns the file path corresponding to the given BCD path.
 * @param ident - An array representing the BCD path.
 * @returns The file path as a string.
 * @throws If the file path cannot be determined from the BCD path.
 */
export const getFilePath = (ident: string[]): string => {
  // Shorten or modify the path depending on the section of BCD. Make a copy
  // of ident so that it can be freely modified.
  let parts = ident.slice();
  if (parts.length >= 2 && parts[0] === "api") {
    // Assume a global if it starts with a lower case character, otherwise
    // an interface with members.
    if (startsWithLowerCase(parts[1])) {
      parts = [parts[0], "_globals", parts[1]];
    } else {
      parts.length = 2;
    }
  } else if (
    parts.length >= 3 &&
    ["css", "html", "svg", "mathml"].includes(parts[0])
  ) {
    parts.length = 3;
  } else if (
    parts.length >= 3 &&
    parts[0] === "javascript" &&
    parts[1] === "builtins"
  ) {
    if (startsWithLowerCase(parts[2])) {
      return "javascript/builtins/globals.json";
    }
    // For cases that look like namespaces like Intl and WebAssembly there
    // should be an additional level or directory.
    if (
      parts.length >= 4 &&
      parts[2] !== parts[3] &&
      jsNamespaces.includes(parts[2]) &&
      startsWithUpperCase(parts[3])
    ) {
      parts.length = 4;
    } else {
      parts.length = 3;
    }
  } else if (parts.length >= 2 && parts[0] === "webassembly") {
    parts.length = 2;
  } else {
    throw new Error(
      `Cannot determine file path from BCD path: ${ident.join(".")}`,
    );
  }
  parts[parts.length - 1] += ".json";
  return path.join(...parts);
};

/* c8 ignore start */
/**
 * Writes the given object to a JSON file at the specified file path.
 * If the file already exists, it merges the new object with the existing data.
 * @param ident - An array of identifiers representing the location within the BCD directory.
 * @param obj - The object to be written to the file.
 * @returns A promise that resolves when the file has been written.
 */
const writeFile = async (ident: string[], obj: any): Promise<void> => {
  // The file path is slightly different in different parts of BCD.
  // As a catch-all case. TODO
  const filepath = path.resolve(BCD_DIR, getFilePath(ident));

  let data = {};
  if (await fs.pathExists(filepath)) {
    data = await fs.readJSON(filepath);
  }

  await fs.writeJSON(
    filepath,
    recursiveAdd(ident.concat(["__compat"]), 0, data, obj.__compat),
    {spaces: 2, replacer: orderFeatures},
  );
};
/* c8 ignore stop */

/**
 * Traverses the features in the given object and writes the supported features to a file.
 * @param obj - The object containing the features to traverse.
 * @param identifier - The identifier of the current feature.
 * @returns A promise that resolves when the traversal is complete.
 */
export const traverseFeatures = async (
  obj: Identifier,
  identifier: string[],
): Promise<any> => {
  for (const i in obj) {
    if (!!obj[i] && typeof obj[i] == "object" && i !== "__compat") {
      const thisIdent = identifier.concat([i]);
      const support = obj[i]?.__compat?.support;
      if (support) {
        for (const statements of Object.values(support)) {
          const supported = (
            Array.isArray(statements) ? statements : [statements]
          ).some((s) => s.version_added && !s.version_removed);
          if (supported) {
            await writeFile(thisIdent, obj[i]);
            break;
          }
        }
      }

      await traverseFeatures(obj[i], thisIdent);
    }
  }
};

/**
 * Collects missing entries from BCD and writes them to a JSON file.
 * @param filepath - The path of the JSON file to write the missing entries to.
 * @returns A Promise that resolves when the missing entries are written to the file.
 */
export const collectMissing = async (filepath: string): Promise<void> => {
  const missing = {};

  for (const entry of getMissing(bcd, tests, "bcd-from-collector")
    .missingEntries) {
    recursiveAdd(entry.split("."), 0, missing, template);
  }

  await fs.ensureFile(filepath);
  await fs.writeJSON(filepath, missing, {spaces: 2});
};

/* c8 ignore start */
/**
 * Main function that generates missing BCD, updates BCD, injects BCD, cleans up, and completes the process.
 * @returns A Promise that resolves when the process is complete.
 */
const main = async (): Promise<void> => {
  const filepath = path.resolve(
    path.join(BCD_DIR, "__missing", "__missing.json"),
  );

  console.log("Generating missing BCD...");
  await collectMissing(filepath);
  await updateBcd(
    ["../mdn-bcd-results/"],
    {addNewFeatures: true},
    bcd.browsers,
    overrides,
  );

  console.log("Injecting BCD...");
  const data = await fs.readJSON(filepath);
  await traverseFeatures(data, []);

  console.log("Cleaning up...");
  await fs.remove(filepath);
  execSync("npm run fix", {cwd: BCD_DIR});

  console.log("Done!");
};

if (esMain(import.meta)) {
  await main();
}
/* c8 ignore stop */
