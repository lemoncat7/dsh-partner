import { readFile } from 'node:fs/promises'

// Isolate plugin behaviour from host-only primitive dependencies in fixtures.
// Production still imports the host's actual icons and native module loader.
export const pendantFixtureOptions = {
  banner: { js: `var require={async:()=>import('/partner-local/v1/pendant/renderer.js')};` },
  plugins: [{ name: 'host-fixture-icons', setup(build) {
    build.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'host-fixture'}))
    build.onLoad({filter:/.*/,namespace:'host-fixture'},async()=>{
      const source=await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',import.meta.url),'utf8')
      const names=[...new Set(source.match(/\bIcon\w+/g))]
      return {contents:names.map(name=>`export const ${name}=()=>null;`).join('\n'),loader:'js'}
    })
  }}],
}
