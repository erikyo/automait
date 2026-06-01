import { defineConfig } from "tsdown";

export default defineConfig({
	name: "tsup",
	target: "node18",
	format: ["esm", "cjs"],
	entry: ["src/cli.js"],
	skipNodeModulesBundle: true,
	dts: false,
	unbundle: true,
	treeshake: false,
	minify: true,
	shims: true,
	clean: true,
	outDir: "lib",
	outExtensions({ format }) {
		return {
			js: format === "cjs" ? ".cjs" : ".js",
		};
	},
});
