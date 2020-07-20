import { posix } from 'path';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as acorn from 'acorn';
// Rollup respects "module", Node 14 doesn't.
const cjsDefault = m => ('default' in m ? m.default : m);
const { Parser } = cjsDefault(acorn);

/**
 * @param {import('rollup').Plugin[]} plugins
 * @param {import('rollup').InputOptions & { output?: import('rollup').OutputOptions, cwd?: string, modules?: Map, writeFile?(name: string, source: string):void }} [opts]
 */
export function createPluginContainer(plugins, opts = {}) {
	if (!Array.isArray(plugins)) plugins = [plugins];

	const MODULES = opts.modules || new Map();

	function generateFilename({ type, name, fileName, source }) {
		if (!fileName) {
			fileName =
				(type === 'entry' && ctx.outputOptions.file) || ctx.outputOptions[type + 'FileNames'] || '[name][extname]';
			fileName = fileName.replace('[hash]', () => createHash('md5').update(source).digest('hex').substring(0, 5));
			fileName = fileName.replace('[extname]', posix.extname(name));
			fileName = fileName.replace('[ext]', posix.extname(name).substring(1));
			fileName = fileName.replace('[name]', posix.basename(name).replace(/\.[a-z0-9]+$/g, ''));
		}
		const result = posix.resolve(opts.cwd || '.', ctx.outputOptions.dir || '.', fileName);
		// const file = posix.resolve(opts.cwd || '.', ctx.outputOptions.dir || '.', fileName || name);
		// console.log('filename for ' + name + ': ', result);
		return result;
	}

	// counter for generating unique emitted asset IDs
	let ids = 0;
	let files = new Map();

	let watchFiles = new Set();

	let plugin;
	let parser = Parser;
	const ctx = {
		meta: {},
		options: {},
		outputOptions: {
			dir: opts.output && opts.output.dir,
			file: opts.output && opts.output.file,
			entryFileNames: opts.output && opts.output.entryFileNames,
			chunkFileNames: opts.output && opts.output.chunkFileNames,
			assetFileNames: opts.output && opts.output.assetFileNames
		},
		parse(code, opts) {
			return parser.parse(code, {
				sourceType: 'module',
				ecmaVersion: 2020,
				locations: true,
				onComment: [],
				...opts
			});
		},
		async resolve(id, importer) {
			let out = await container.resolveId(id, importer);
			if (typeof out === 'string') out = { id: out };
			if (!out || !out.id) {
				if (id && id.match(/^\.\.?[/\\]/)) {
					if (importer && importer.match(/^\.\.?[/\\]/)) {
						id = posix.resolve(importer, id);
					}
					id = posix.resolve(opts.cwd || '.', id);
					out = { id };
				}
			}
			return out || false;
		},
		getModuleInfo(id) {
			let mod = MODULES.get(id);
			if (mod) return mod.info;
			mod = {
				info: {}
			};
			MODULES.set(id, mod);
			return mod.info;
		},
		emitFile({ type, name, fileName, source }) {
			if (type !== 'asset') throw Error(`Unsupported type ${type}`);
			const id = String(++ids);
			const filename = fileName || generateFilename({ type, name, source, fileName });
			files.set(id, { id, name, filename });
			if (opts.writeFile) opts.writeFile(filename, source);
			else fs.writeFile(filename, source);
			return id;
		},
		addWatchFile(id) {
			watchFiles.add(id);
		},
		warn(...args) {
			console.log(`[${plugin.name}]`, ...args);
		}
	};

	const container = {
		ctx,

		/**
		 * @todo this is now an async series hook in rollup, need to find a way to allow for that here.
		 * @type {OmitThisParameter<import('rollup').PluginHooks['options']>}
		 */
		options(options) {
			for (plugin of plugins) {
				if (!plugin.options) continue;
				options = plugin.options.call(ctx, options) || options;
			}
			if (options.acornInjectPlugins) {
				parser = Parser.extend(...[].concat(options.acornInjectPlugins));
			}
			return options;
		},

		/** @param {object} options */
		async buildStart() {
			await Promise.all(
				plugins.map(plugin => {
					if (plugin.buildStart) {
						plugin.buildStart.call(ctx, ctx.options);
					}
				})
			);
		},

		/** @param {string} id */
		watchChange(id) {
			if (watchFiles.has(id)) {
				for (plugin of plugins) {
					if (!plugin.watchChange) continue;
					plugin.watchChange.call(ctx, id);
				}
			}
		},

		/** @param {string} property */
		resolveImportMeta(property) {
			for (plugin of plugins) {
				if (!plugin.resolveImportMeta) continue;
				const result = plugin.resolveImportMeta.call(ctx, property);
				if (result) return result;
			}

			// handle file URLs by default
			const matches = property.match(/^ROLLUP_FILE_URL_(\d+)$/);
			if (matches) {
				const result = container.resolveFileUrl({ referenceId: matches[1] });
				if (result) return result;
			}
		},

		/**
		 * @param {string} id
		 * @param {string} [importer]
		 * @returns {Promise<import('rollup').ResolveIdResult>}
		 */
		async resolveId(id, importer) {
			const opts = {};
			for (plugin of plugins) {
				if (!plugin.resolveId) continue;
				const result = await plugin.resolveId.call(ctx, id, importer);
				if (!result) return null;
				if (typeof result === 'string') {
					id = result;
				} else {
					id = result.id;
					Object.assign(opts, result);
				}
			}
			opts.id = id;
			return Object.keys(opts).length > 1 ? opts : id;
		},

		/**
		 * @param {string} code
		 * @param {string} id
		 */
		async transform(code, id) {
			for (plugin of plugins) {
				if (!plugin.transform) continue;
				const result = await plugin.transform.call(ctx, code, id);
				if (!result) continue;
				if (typeof result === 'object') {
					code = result.code;
				} else {
					code = result;
				}
			}
			return code;
		},

		/**
		 * @param {string} id
		 * @returns {Promise<string | { code: string, map?: any } | null>}
		 */
		async load(id) {
			for (plugin of plugins) {
				if (!plugin.load) continue;
				const result = await plugin.load.call(ctx, id);
				if (result) {
					return result;
				}
			}
			return null;
		},

		resolveFileUrl({ referenceId }) {
			const file = files.get(String(referenceId));
			if (file == null) return null;
			const out = posix.resolve(opts.cwd || '.', ctx.outputOptions.dir || '.');
			const filename = posix.relative(out, file.filename);
			return JSON.stringify('/' + filename);
		}
	};

	ctx.options = container.options({
		acornInjectPlugins: []
	});

	return container;
}
