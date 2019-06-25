import globals from 'rollup-plugin-node-globals'; // axios shenanigans
import builtins from 'rollup-plugin-node-builtins'; // axios shenanigans
import json from 'rollup-plugin-json'; // axios shenanigans
import resolve from 'rollup-plugin-node-resolve';
import commonjs from 'rollup-plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';

export default {
    input: 'script.ts',
    output: {
        file: 'bundle.js',
        format: 'iife',
        name: 'toymosaic'
    },
    plugins: [
        resolve({jsnext: true, preferBuiltins: true, browser: true}),
        commonjs({
            include: 'node_modules/**',
            namedExports: {
                'node_modules/react/index.js': ['Children', 'Component', 'PropTypes', 'createElement'],
                'node_modules/react-dom/index.js': ['render'],
                'node_modules/react-is/index.js': ['isForwardRef', 'isValidElementType'],
                'node_modules/falcor/lib/index.js': ['PathSet', 'Path', 'DataSource', 'JSONGraph', 'JSONGraphEnvelope', 'Observable']
            }
        }),
        globals(),
        builtins(),
        json(),
        typescript()
    ]
};
