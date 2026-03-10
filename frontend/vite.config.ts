import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svelteRoot = resolve(__dirname, '../node_modules/svelte');

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		proxy: {
			'/api': {
				target: 'http://localhost:3333',
				changeOrigin: true
			}
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		setupFiles: ['src/lib/__tests__/setup.ts'],
		alias: [
			{ find: /^svelte$/, replacement: resolve(svelteRoot, 'src/index-client.js') },
			{ find: /^svelte\/internal$/, replacement: resolve(svelteRoot, 'src/internal/client/index.js') },
		],
	}
});
