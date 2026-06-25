import { env } from './env';
import { NBTParser, findChildTagAtPath } from 'mc-anvil';
import fs from 'fs';
import { toArrayBuffer, walk } from './utils';
import { forEachChunk } from './worldloader';

const main = async () => {
	const worldDir = env.WORLD_PATH;
	const outputDir = env.OUTPUT_PATH;

	if (!fs.existsSync(worldDir)) {
		console.error(`Error: The specified world directory "${worldDir}" does not exist.`);
		process.exit(1);
	}

	if (!fs.existsSync(outputDir)) {
		console.error(`Error: The specified output directory "${outputDir}" does not exist.`);
		process.exit(1);
	}

	// Read level.dat
	console.log("Reading world's level.dat...");
	const levelDatPath = `${worldDir}/level.dat`;
	if (!fs.existsSync(levelDatPath)) {
		console.error(`Error: The level.dat file does not exist in the specified world directory "${worldDir}".`);
		process.exit(1);
	}

	const levelDatBuffer = toArrayBuffer(fs.readFileSync(levelDatPath));
	const nbtParser = new NBTParser(levelDatBuffer);
	const rootTag = nbtParser.getTag();

	// Print all values in the entire level.dat NBT structure for debugging
	walk(rootTag);

	const levelName = findChildTagAtPath('Data/LevelName', rootTag)?.data;
	console.log(`World name: ${levelName}`);
	const mcVersion = findChildTagAtPath('Data/Version/Name', rootTag)?.data;
	console.log(`Minecraft version used for the world: ${mcVersion}`);
	const dataVersion = findChildTagAtPath('DataVersion', rootTag)?.data;
	console.log(`Data version: ${dataVersion}`);
	const wasModded = findChildTagAtPath('Data/WasModded', rootTag)?.data !== 0;
	if (wasModded) {
		console.warn('Warning: The world was modded. This may affect the output.');
	}
	const worldInitialized = findChildTagAtPath('Data/Initialized', rootTag)?.data !== 0;
	if (!worldInitialized) {
		throw new Error('Error: The world is not initialized. Please ensure the world is properly set up before running this script.');
	}

	let chunkCount = 0;
	await forEachChunk(worldDir, 'minecraft:overworld', (chunk, file) => {
		const coords = chunk.getChunkCoordinates();
		if (!coords) {
			console.warn(`Warning: Could not determine coordinates for chunk in file: ${file}`);
			return;
		}
		console.log(`Found chunk at coordinates: (${coords?.[0]}, ${coords?.[1]}) in file: ${file}`);
		chunkCount++;
	});
	console.log(`Total chunks found: ${chunkCount}`);
};

main().catch(err => {
	console.error('An error occurred:', err);
	process.exit(1);
});
