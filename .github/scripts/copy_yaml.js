const fs = require('fs');
const yaml = require('js-yaml'); // We'll install this npm package

const sourceYamlPath = process.env.SOURCE_YAML_PATH;
const targetYamlPath = process.env.TARGET_YAML_PATH;

if (!sourceYamlPath || !targetYamlPath) {
  console.error('Error: SOURCE_YAML_PATH and TARGET_YAML_PATH environment variables must be set.');
  process.exit(1);
}

try {
  // 1. Read the content of the source YAML file
  const sourceContent = fs.readFileSync(sourceYamlPath, 'utf8');

  // 2. Parse the YAML content
  const parsedYaml = yaml.load(sourceContent);

  // 3. Dump the parsed content back into YAML format (this ensures proper formatting and validation)
  const dumpedYaml = yaml.dump(parsedYaml);

  // 4. Write the content to the target YAML file
  fs.writeFileSync(targetYamlPath, dumpedYaml, 'utf8');

  console.log(`Successfully copied content from '${sourceYamlPath}' to '${targetYamlPath}'`);
} catch (error) {
  console.error(`Error copying YAML file: ${error.message}`);
  process.exit(1);
}
