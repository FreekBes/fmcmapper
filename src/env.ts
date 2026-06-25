/// <reference types="node" />

// Get the environment variables either from the env or from arguments
export const env = {
	WORLD_PATH: process.env.WORLD_PATH || process.argv[2] || '',
	OUTPUT_PATH: process.env.OUTPUT_PATH || process.argv[3] || ''
};

if (!env.WORLD_PATH) {
	console.error('Error: WORLD_PATH is not set. Please provide the path to the Minecraft world.');
	process.exit(1);
}

if (!env.OUTPUT_PATH) {
	console.error('Error: OUTPUT_PATH is not set. Please provide the path for the output.');
	process.exit(1);
}
