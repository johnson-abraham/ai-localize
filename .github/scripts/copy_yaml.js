const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
// Remove this line if you are only using Google GenAI:
// const { TranslationServiceClient } = require('@google-cloud/translate');

const { GoogleGenAI } = require('@google/genai'); // This is the one you need

const sourceYamlPath = process.env.SOURCE_YAML_PATH;
const targetYamlPath = process.env.TARGET_YAML_PATH;

// --- Initialize Google GenAI ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error('Error: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}
// const genAI = new GoogleGenerativeAI(geminiApiKey);
// You can choose different models here based on your needs: 'gemini-pro', 'gemini-1.5-flash-latest', etc.
// const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// ------------------------------

const ai = new GoogleGenAI({});

if (!sourceYamlPath || !targetYamlPath) {
  console.error('Error: SOURCE_YAML_PATH and TARGET_YAML_PATH environment variables must be set.');
  process.exit(1);
}

// Function to recursively translate strings in an object using Google GenAI
async function translateObject(obj, targetLanguage) {
  const translatedObj = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (typeof value === 'string') {
        if (value.trim() !== '') {
          try {
            console.log(`Translating (GenAI): "${value}"`);
            // The prompt asks for direct translation. Experiment with prompts for best results.
            const prompt = `Translate the following English text to ${targetLanguage}. Only return the translated text:\n\n"${value}"`;
            const result = await ai.models.generateContent({contents: prompt, model: "gemini-2.5-flash",});
            const translatedText = result.text;
            translatedObj[key] = translatedText.trim();
            console.log(`Translated "${value}" to "${translatedObj[key]}"`);
          } catch (error) {
            console.error(`Error translating key "${key}" with GenAI: ${error.message}`);
            translatedObj[key] = `[Translation Error with GenAI] ${value}`; // Indicate error
          }
        } else {
          translatedObj[key] = value; // Keep empty strings as they are
        }
      } else if (typeof value === 'object' && value !== null) {
        translatedObj[key] = await translateObject(value, targetLanguage);
      } else {
        translatedObj[key] = value;
      }
    }
  }
  return translatedObj;
}

async function main() {
  try {
    console.log(`Reading source file: ${sourceYamlPath}`);
    const sourceContent = fs.readFileSync(sourceYamlPath, 'utf8');
    const englishStrings = yaml.load(sourceContent);

    console.log('Starting translation to French using Google GenAI...');
    // Pass 'French' to the translateObject function, as the prompt uses the human-readable language name.
    const frenchStrings = await translateObject(englishStrings, 'French');

    console.log('Dumping translated content to YAML...');
    const dumpedYaml = yaml.dump(frenchStrings, { indent: 2 });

    const targetDirectory = path.dirname(targetYamlPath);
    if (!fs.existsSync(targetDirectory)) {
      console.log(`Creating target directory: ${targetDirectory}`);
      fs.mkdirSync(targetDirectory, { recursive: true });
    }

    console.log(`Writing translated content to target file: ${targetYamlPath}`);
    fs.writeFileSync(targetYamlPath, dumpedYaml, 'utf8');

    console.log(`Successfully translated and copied content from '${sourceYamlPath}' to '${targetYamlPath}'`);
  } catch (error) {
    console.error(`Fatal error in translation process: ${error.message}`);
    process.exit(1);
  }
}

main();
