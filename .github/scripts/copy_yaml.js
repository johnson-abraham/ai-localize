const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { GoogleGenAI } = require("@google/genai");

const sourceYamlPath = process.env.SOURCE_YAML_PATH;
const targetYamlPath = process.env.TARGET_YAML_PATH;

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const ai = new GoogleGenAI({});

if (!sourceYamlPath || !targetYamlPath) {
  console.error(
    "Error: SOURCE_YAML_PATH and TARGET_YAML_PATH environment variables must be set.",
  );
  process.exit(1);
}

function getFileContentFromCommit(filePath, commitRef) {
  try {
    return execSync(`git show ${commitRef}:${filePath}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
  } catch (error) {
    return "";
  }
}

/**
 * Recursively finds changed string values between two YAML objects (additions/modifications).
 * Returns an object with dot-separated keys and their new string values.
 */
function getChangedStrings(currentObj, previousObj, changes = {}, prefix = "") {
  for (const key in currentObj) {
    if (Object.prototype.hasOwnProperty.call(currentObj, key)) {
      const currentVal = currentObj[key];
      const previousVal = previousObj ? previousObj[key] : undefined;
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof currentVal === "string") {
        if (currentVal !== previousVal) {
          changes[fullKey] = currentVal;
        }
      } else if (
        typeof currentVal === "object" &&
        currentVal !== null &&
        !Array.isArray(currentVal)
      ) {
        getChangedStrings(currentVal, previousVal, changes, fullKey);
      }
    }
  }
  return changes;
}

/**
 * Recursively removes keys from targetObj if they are missing in sourceObj.
 * @param {object} targetObj - The object to modify (e.g., existing French translations).
 * @param {object} sourceObj - The reference object (e.g., current English strings).
 * @returns {boolean} True if any keys were deleted, false otherwise.
 */
function removeDeletedKeys(targetObj, sourceObj) {
  let hasDeleted = false;
  for (const key in targetObj) {
    if (Object.prototype.hasOwnProperty.call(targetObj, key)) {
      if (!Object.prototype.hasOwnProperty.call(sourceObj, key)) {
        // Key exists in target but not in source: delete it
        console.log(`Deleting key '${key}' from target translations.`);
        delete targetObj[key];
        hasDeleted = true;
      } else if (
        typeof targetObj[key] === "object" &&
        targetObj[key] !== null &&
        !Array.isArray(targetObj[key]) &&
        typeof sourceObj[key] === "object" &&
        sourceObj[key] !== null &&
        !Array.isArray(sourceObj[key])
      ) {
        // Recurse for nested objects
        if (removeDeletedKeys(targetObj[key], sourceObj[key])) {
          hasDeleted = true;
        }
      }
    }
  }
  return hasDeleted;
}

async function translateString(text, targetLanguage) {
  if (text.trim() === "") {
    return text;
  }
  try {
    console.log(`Translating (GenAI): "${text}"`);
    const prompt = `Translate the following English text to ${targetLanguage}. Only return the translated text:\n\n"${text}"`;
    const result = await ai.models.generateContent({
      contents: prompt,
      model: "gemini-2.5-flash",
    });
    const translatedText = result.text;
    console.log(`Translated "${text}" to "${translatedText}"`);
    return translatedText.trim();
  } catch (error) {
    console.error(`ERROR during GenAI translation for text "${text}":`);
    console.error(error);
    if (error.response) {
      console.error(
        "API Response Error:",
        error.response.status,
        error.response.statusText,
      );
      if (error.response.data) {
        console.error("API Response Data:", error.response.data);
      }
    } else if (error.message) {
      console.error("Error message:", error.message);
    }
    return `[Translation Error with GenAI] ${text}`;
  }
}

function setDeep(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !current[part] ||
      typeof current[part] !== "object" ||
      Array.isArray(current[part])
    ) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

async function main() {
  try {
    // 1. Get current and previous versions of src/global.yaml
    console.log(`Reading current source file: ${sourceYamlPath}`);
    const currentSourceContent = fs.readFileSync(sourceYamlPath, "utf8");
    const currentEnglishStrings = yaml.load(currentSourceContent);

    const previousCommitSha = process.env.GITHUB_SHA_BEFORE;
    console.log(
      `Fetching previous source file content from commit: ${previousCommitSha || "initial commit (no previous SHA)"}`,
    );
    const previousSourceContent = getFileContentFromCommit(
      sourceYamlPath,
      previousCommitSha,
    );
    const previousEnglishStrings = previousSourceContent
      ? yaml.load(previousSourceContent)
      : {};

    // 2. Load existing target file (French) or initialize if not exists
    let existingFrenchStrings = {};
    if (fs.existsSync(targetYamlPath)) {
      console.log(`Loading existing target file: ${targetYamlPath}`);
      const existingTargetContent = fs.readFileSync(targetYamlPath, "utf8");
      existingFrenchStrings = yaml.load(existingTargetContent);
    } else {
      console.log(
        `Target file ${targetYamlPath} does not exist. Will create a new one.`,
      );
    }

    // Clone existingFrenchStrings to modify (important to avoid modifying original reference if used elsewhere)
    const finalFrenchStrings = JSON.parse(
      JSON.stringify(existingFrenchStrings),
    ); // Simple deep clone

    let hasActualChanges = false; // Flag to check if any final content change occurred

    // --- Handle Deleted Keys First ---
    console.log("Checking for deleted keys...");
    if (removeDeletedKeys(finalFrenchStrings, currentEnglishStrings)) {
      hasActualChanges = true;
    }

    // --- Handle Added/Modified Keys ---
    console.log("Identifying added/modified strings...");
    const stringsToTranslate = getChangedStrings(
      currentEnglishStrings,
      previousEnglishStrings,
    );
    const changedKeys = Object.keys(stringsToTranslate);

    if (changedKeys.length === 0 && !hasActualChanges) {
      // No changes AND no deletions
      console.log(
        "No new, modified, or deleted strings found in src/global.yaml. No translation or file update needed.",
      );
      process.exit(0); // Exit successfully
    }

    if (changedKeys.length > 0) {
      console.log(`Found ${changedKeys.length} strings to translate/update.`);
      console.log("Keys to translate:", changedKeys.join(", "));

      for (const key of changedKeys) {
        const englishText = stringsToTranslate[key];
        const translatedText = await translateString(englishText, "French");

        // Retrieve current value from the working 'finalFrenchStrings'
        let currentTranslatedValue;
        try {
          // Traverse the object to get the value at the specific path
          currentTranslatedValue = key
            .split(".")
            .reduce((o, i) => o && o[i], finalFrenchStrings);
        } catch (e) {
          currentTranslatedValue = undefined; // Path might not exist in existing structure
        }

        if (translatedText !== currentTranslatedValue) {
          setDeep(finalFrenchStrings, key, translatedText);
          hasActualChanges = true;
          console.log(`Updated translation for key "${key}"`);
        } else {
          console.log(
            `No change in translated text for key "${key}", skipping update.`,
          );
        }
      }
    }

    if (!hasActualChanges) {
      console.log(
        "No actual content changes (additions, modifications, or deletions) were detected after processing. No file write needed.",
      );
      process.exit(0); // Exit successfully, no file changes.
    }

    // 5. Dump the final French content back into YAML format
    console.log("Dumping final French content to YAML...");
    const dumpedYaml = yaml.dump(finalFrenchStrings, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: true,
    });

    // 6. Ensure the target directory exists
    const targetDirectory = path.dirname(targetYamlPath);
    if (!fs.existsSync(targetDirectory)) {
      console.log(`Creating target directory: ${targetDirectory}`);
      fs.mkdirSync(targetDirectory, { recursive: true });
    }

    // 7. Write the content to the target YAML file (French)
    console.log(
      `Writing updated translated content to target file: ${targetYamlPath}`,
    );
    fs.writeFileSync(targetYamlPath, dumpedYaml, "utf8");

    console.log(`Successfully updated changed strings in '${targetYamlPath}'`);
  } catch (error) {
    console.error(`Fatal error in translation process: ${error.message}`);
    process.exit(1);
  }
}

main();
