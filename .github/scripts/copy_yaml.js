const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process"); // For running git commands
const yaml = require("js-yaml");
const { GoogleGenerativeAI } = require("@google/genai");

const sourceYamlPath = process.env.SOURCE_YAML_PATH; // src/global.yaml (English)
const targetYamlPath = process.env.TARGET_YAML_PATH; // generated/global.yaml (French)

const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  console.error("Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}
// const genAI = new GoogleGenerativeAI(geminiApiKey);
// You can choose different models here based on your needs: 'gemini-pro', 'gemini-1.5-flash-latest', etc.
// const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// ------------------------------

const ai = new GoogleGenAI({});

if (!sourceYamlPath || !targetYamlPath) {
  console.error(
    "Error: SOURCE_YAML_PATH and TARGET_YAML_PATH environment variables must be set.",
  );
  process.exit(1);
}

/**
 * Gets the content of a file from a specific Git commit.
 * @param {string} filePath - The path to the file.
 * @param {string} commitRef - The Git commit reference (e.g., 'HEAD^', or a SHA).
 * @returns {string} The file content, or an empty string if not found/error.
 */
function getFileContentFromCommit(filePath, commitRef) {
  try {
    // `git show` retrieves the content of a file at a specific commit
    return execSync(`git show ${commitRef}:${filePath}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
  } catch (error) {
    // If the file didn't exist in the previous commit, or other error, return empty string
    // console.warn(`Warning: Could not get content of '${filePath}' from commit '${commitRef}'. It might be a new file or path issue. Error: ${error.message.trim()}`);
    return "";
  }
}

/**
 * Recursively finds changed string values between two YAML objects.
 * Returns an object with dot-separated keys and their new string values.
 * @param {object} currentObj - The current parsed YAML object.
 * @param {object} previousObj - The previous parsed YAML object.
 * @param {object} [changes={}] - Accumulator for changes.
 * @param {string} [prefix=''] - Current dot-separated path prefix.
 * @returns {object} Object containing only the changed string key-value pairs.
 */
function getChangedStrings(currentObj, previousObj, changes = {}, prefix = "") {
  for (const key in currentObj) {
    if (Object.prototype.hasOwnProperty.call(currentObj, key)) {
      const currentVal = currentObj[key];
      const previousVal = previousObj ? previousObj[key] : undefined; // Ensure previousVal is defined if previousObj exists
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof currentVal === "string") {
        // Only consider actual string value changes or new strings
        if (currentVal !== previousVal) {
          changes[fullKey] = currentVal;
        }
      } else if (
        typeof currentVal === "object" &&
        currentVal !== null &&
        !Array.isArray(currentVal)
      ) {
        // If it's a nested object (and not an array), recurse
        getChangedStrings(currentVal, previousVal, changes, fullKey);
      }
      // If a key was removed from the previous, or if arrays are involved,
      // this simple diff won't capture that. More complex diffing logic
      // would be needed for array element changes or key deletions.
    }
  }
  return changes;
}

/**
 * Translates a single string using Google GenAI.
 * @param {string} text - The text to translate.
 * @param {string} targetLanguage - The target language (e.g., 'French').
 * @returns {Promise<string>} The translated text or an error indicator.
 */
async function translateString(text, targetLanguage) {
  if (text.trim() === "") {
    return text; // Don't translate empty strings
  }
  try {
    console.log(`Translating (GenAI): "${text}"`);
    const prompt = `Translate the following English text to ${targetLanguage}. Only return the translated text:\n\n"${text}"`;
    const result = await ai.models.generateContent({
      contents: prompt,
      model: "gemini-2.5-flash",
    });
    const translatedText = result.text; // As per your working code
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
    return `[Translation Error with GenAI] ${text}`; // Indicate error
  }
}

/**
 * Recursively sets a value in an object based on a dot-separated key.
 * Creates intermediate objects if they don't exist.
 * @param {object} obj - The object to modify.
 * @param {string} path - Dot-separated path (e.g., 'app.title').
 * @param {*} value - The value to set.
 */
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
      current[part] = {}; // Initialize as an empty object if not already a plain object
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

    // Get content from the previous commit (using GITHUB_SHA_BEFORE)
    const previousCommitSha = process.env.GITHUB_SHA_BEFORE;
    // For the very first commit, github.event.before is '0000000000000000000000000000000000000000'
    // In such cases, previousSourceContent will be empty, and previousEnglishStrings will be {}
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

    // 2. Identify changed strings
    console.log("Identifying changed strings...");
    const stringsToTranslate = getChangedStrings(
      currentEnglishStrings,
      previousEnglishStrings,
    );
    const changedKeys = Object.keys(stringsToTranslate);

    if (changedKeys.length === 0) {
      console.log(
        "No new or modified strings found in src/global.yaml. No translation needed.",
      );
      // Signal to the next step (Create PR) that no changes were made.
      // This can be done by not modifying the target file, or by creating a flag.
      // For create-pull-request action, if add-paths finds no changes, it won't create a PR.
      process.exit(0); // Exit successfully
    }

    console.log(`Found ${changedKeys.length} strings to translate.`);
    console.log("Keys to translate:", changedKeys.join(", ")); // Log only the keys for brevity in common cases

    // 3. Load existing target file (French) or initialize if not exists
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

    // 4. Translate only the changed strings and merge into existing French strings
    const finalFrenchStrings = { ...existingFrenchStrings }; // Start with existing translations
    let hasActualChanges = false; // Flag to check if translation results in file change

    for (const key of changedKeys) {
      const englishText = stringsToTranslate[key];
      const translatedText = await translateString(englishText, "French");

      // Check if the translated text is actually different from what's currently there (if it exists)
      // This is important because GenAI might return same text if input is already French or very simple.
      let currentTranslatedValue;
      try {
        currentTranslatedValue = key
          .split(".")
          .reduce((o, i) => o[i], existingFrenchStrings);
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

    if (!hasActualChanges) {
      console.log(
        "No actual translated content changes were detected after processing. No file write needed.",
      );
      process.exit(0); // Exit successfully, no file changes.
    }

    // 5. Dump the final French content back into YAML format
    console.log("Dumping final French content to YAML...");
    const dumpedYaml = yaml.dump(finalFrenchStrings, { indent: 2 });

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
