import path from 'path';
import { promises as fs } from 'fs';
import { setupTest, teardown, runWmr, loadFixture, waitForMessage } from './test-helpers.js';

jest.setTimeout(30000);

const addrs = new WeakMap();

const runWmrFast = (cwd, ...args) => runWmr(cwd, '--no-optimize', '--no-compress', ...args);

async function getOutput(env, instance) {
	let address = addrs.get(instance);
	if (!address) {
		await waitForMessage(instance.output, /^Listening/);
		address = instance.output.join('\n').match(/https?:\/\/localhost:\d+/g)[0];
		addrs.set(instance, address);
	}

	await env.page.goto(address);
	return await env.page.content();
}

describe('fixtures', () => {
	/** @type {TestEnv} */
	let env;
	/** @type {WmrInstance} */
	let instance;

	beforeEach(async () => {
		env = await setupTest();
	});

	afterEach(async () => {
		await teardown(env);
		instance.close();
	});

	it('should listen on port', async () => {
		await loadFixture('htmlonly', env);
		instance = await runWmrFast(env.tmp.path);

		// await waitForMessage(instance.output, /^Listening/);

		// const address = instance.output.join('\n').match(/https?:\/\/localhost:\d+/g)[0];

		// await env.page.goto(address);

		// expect(await env.page.content()).toMatch(`<h1>Hello wmr</h1>`);

		const content = await getOutput(env, instance);
		expect(content).toMatch(`<h1>Hello wmr</h1>`);
	});

	it('should build', async () => {
		await loadFixture('simple', env);
		instance = await runWmrFast(env.tmp.path, 'build');

		await waitForMessage(instance.output, /Wrote/);

		const files = await fs.readdir(env.tmp.path);
		expect(files).toEqual(['dist', 'public']);

		const dist = await fs.readdir(path.join(env.tmp.path, 'dist'));
		expect(dist).toContainEqual(expect.stringMatching(/^index\.[a-z0-9]+\.js$/));
	});

	describe('empty', () => {
		it('should print warning for missing index.html file in public dir', async () => {
			await loadFixture('empty', env);
			instance = await runWmrFast(env.tmp.path);
			expect(instance.output[0]).toMatch(`missing "index.html" file`);
			expect(await getOutput(env, instance)).toMatch(`Not Found`);
		});

		it('should print warning for missing index.html file (no public dir)', async () => {
			await loadFixture('empty-nopublic', env);
			instance = await runWmrFast(env.tmp.path);
			expect(instance.output[0]).toMatch(`missing "index.html" file`);
			expect(await getOutput(env, instance)).toMatch(`Not Found`);
		});

		it('should start successfully with only an HTML file in public dir', async () => {
			await loadFixture('htmlonly', env);
			instance = await runWmrFast(env.tmp.path);
			expect(instance.output[0]).not.toMatch(`missing an "index.html"`);
			expect(await getOutput(env, instance)).toMatch(`<h1>Hello wmr</h1>`);
		});

		it('should start successfully with only an HTML file (no public dir)', async () => {
			await loadFixture('htmlonly-nopublic', env);
			instance = await runWmrFast(env.tmp.path);
			expect(instance.output[0]).not.toMatch(`missing an "index.html"`);
			expect(await getOutput(env, instance)).toMatch(`<h1>Hello wmr</h1>`);
		});
	});

	describe('url: import prefix', () => {
		it('should return ?asset URLs in development', async () => {
			await loadFixture('url-prefix', env);
			instance = await runWmrFast(env.tmp.path);
			const output = await getOutput(env, instance);
			expect(output).toMatch(/<pre id="out">{.+}<\/pre>/);
			const json = JSON.parse(await env.page.$eval('#out', el => el.textContent));
			expect(json).toHaveProperty('htmlUrl', '/index.html?asset');
			expect(json).toHaveProperty('selfUrl', '/index.js?asset');
			const out = await env.page.evaluate(async () => await (await fetch('/index.js?asset')).text());
			expect(out).toEqual(await fs.readFile(path.resolve(__dirname, 'fixtures/url-prefix/index.js'), 'utf-8'));
		});
	});

	describe('alias', () => {
		it('should allow specifying preact/compat alias', async () => {
			await loadFixture('alias', env);
			instance = await runWmrFast(env.tmp.path);
			const output = await getOutput(env, instance);
			expect(output).toMatch(/preact was used to render/);
			expect(await env.page.evaluate(`window.React === window.preactCompat`)).toBe(true);
			expect(await env.page.evaluate(`window.ReactDOM === window.preactCompat`)).toBe(true);
		});
	});

	describe('rmwc', () => {
		it('should run rmwc demo', async () => {
			await loadFixture('rmwc', env);
			instance = await runWmrFast(env.tmp.path);
			const output = await getOutput(env, instance);
			expect(output).toMatch(/Pizza/i);
			expect(await env.page.evaluate(`window.didRender`)).toBe(true);
		});

		it('should follow resolutions', async () => {
			await loadFixture('rmwc', env);
			const pkg = path.join(env.tmp.path, 'package.json');
			const pkgJson = JSON.parse(await fs.readFile(pkg, 'utf-8'));
			pkgJson.resolutions = {
				'@material/**': '^5.0.0'
			};
			await fs.writeFile(pkg, JSON.stringify(pkgJson, null, 2));
			instance = await runWmrFast(env.tmp.path);
			const output = await getOutput(env, instance);
			expect(output).toMatch(/Pizza/i);
			expect(await env.page.evaluate(`window.didRender`)).toBe(true);
		});
	});

	describe('external scripts', () => {
		it('should not transpile CJS', async () => {
			await loadFixture('external-scripts', env);
			instance = await runWmrFast(env.tmp.path);
			await getOutput(env, instance);
			expect(await env.page.$eval('h1', el => el.textContent)).toBe('EXTERNAL SCRIPT LOADED');
		});

		it('should use ?asset to bypass transforms', async () => {
			await loadFixture('external-scripts', env);
			instance = await runWmrFast(env.tmp.path);
			await getOutput(env, instance);
			expect(await env.page.$eval('h1', el => el.textContent)).toBe('EXTERNAL SCRIPT LOADED');
		});
	});

	describe('commonjs', () => {
		it('should transpile .cjs files', async () => {
			await loadFixture('commonjs', env);
			instance = await runWmrFast(env.tmp.path);
			await getOutput(env, instance);
			expect(await env.page.evaluate(`import('/foo.cjs')`)).toEqual({
				default: {
					a: 'one',
					b: 'two'
				}
			});
		});

		// NOTE: This test actually verifies an over-simplified version of CJS that is not ideal.
		// We will want to update these tests to assert that named exports are inferred once
		// WMR has been switched over to using cjs-module-lexer (#109).
		it('should pass smoke test', async () => {
			await loadFixture('commonjs', env);
			instance = await runWmrFast(env.tmp.path);
			await getOutput(env, instance);

			// import * as foo from './foo.cjs'
			expect(await env.page.$eval('#cjs', el => JSON.parse(el.textContent))).toEqual({
				default: {
					a: 'one',
					b: 'two'
				}
			});

			// import foo from './foo.cjs'
			expect(await env.page.$eval('#cjsdefault', el => JSON.parse(el.textContent))).toEqual({
				a: 'one',
				b: 'two'
			});

			// const foo = require('./esm.js')
			expect(await env.page.$eval('#cjsimport', el => JSON.parse(el.textContent))).toEqual({
				default: 'default export',
				a: 1,
				b: 2,
				c: 3
			});
		});
	});

	describe('process', () => {
		it('should support process.env.NODE_ENV', async () => {
			await loadFixture('process', env);
			instance = await runWmrFast(env.tmp.path);
			const output = await getOutput(env, instance);
			expect(output).toMatch(/development/i);
		});
	});
});