import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'partner-test', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }))
server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }] }))
await server.connect(new StdioServerTransport())
