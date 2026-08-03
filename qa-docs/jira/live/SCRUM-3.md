# SCRUM-3: Connect Atlassian Rovo MCP to your local coding tools

- Type: Task
- Status: To Do
- Priority: n/a
- Assignee: Unassigned
- Updated: 2026-08-01T18:51:58.659+0530
- URL: https://mandeepsingh1986.atlassian.net/browse/SCRUM-3

## Description
Bring your Atlassian context into your IDE and terminal with Teamwork Graph. Connect via Rovo MCP or the Teamwork Graph CLI and your agent can read, create, and action work without leaving your editor.
Teamwork Graph CLI and Rovo MCP are both official ways for AI agents to work with Atlassian data via the Teamwork Graph.
MCP: In your browser and desktop agents
Atlassian Rovo MCP connects your AI agent to your Atlassian context – Jira, Confluence, Bitbucket, and connected work, all reachable in one conversation.
Select your tool below to see setup steps:
Prerequisites:
- VS Code installed and updated.

- GitHub Copilot enabled in VS Code.

- Access to edit your VS Code MCP configuration.

- An Atlassian account with access to the Jira content you want to use.

Configuration:
{ "servers": { "atlassian-mcp-server": { "url": "https://mcp.atlassian.com/v1/mcp/authv2", "type": "http" } } }Steps:
- Open VS Code and confirm GitHub Copilot is enabled.

- Open your VS Code MCP configuration file or MCP settings.

- Add the Atlassian Rovo MCP server using the servers configuration format above.

- Save the configuration file.

- Reload the VS Code window or restart VS Code so the MCP configuration is picked up.

- When prompted, complete the Atlassian authentication flow in your browser.

- Return to VS Code and confirm the Atlassian Rovo MCP server is available to Copilot.

Important: GitHub Copilot in VS Code uses a native HTTP MCP connection. Do not use the Claude Desktop mcpServers format or the mcp-remote proxy for this setup.
Prerequisites:
- A modern version of Cursor that supports MCP server configuration.

- Access to Cursor settings.

- An Atlassian account with access to the Jira content you want to use.

Configuration:
"Atlassian-MCP-Server": { "url": "https://mcp.atlassian.com/v1/mcp/authv2" }Steps:
- Open Cursor.

- Go to Cursor settings and find the MCP or Model Context Protocol settings area.

- Add a new MCP server entry.

- Name the server something recognizable, such as Atlassian-MCP-Server.

- Use the direct Atlassian Rovo MCP URL: https://mcp.atlassian.com/v1/mcp/authv2.

- Save the MCP server configuration.

- Restart Cursor or reload the window if the server does not appear immediately.

- Complete the Atlassian authentication flow when prompted.

- Return to Cursor and confirm the Atlassian Rovo MCP server is available.

Important: Modern Cursor versions can connect directly by URL. If Cursor does not recognise the server, confirm your Cursor version supports native HTTP MCP connections before trying another setup style.
Prerequisites:
- Node.js v18 or later installed.

- npx available on your machine.

- Access to edit the Codex MCP configuration file or MCP settings.

- An Atlassian account with access to the Jira content you want to use.

Configuration:
"Atlassian-Rovo-MCP": { "command": "npx", "args": ["-y", "mcp-remote@latest", "https://mcp.atlassian.com/v1/mcp/authv2"] }Steps:
- Confirm Node.js v18+ and npx are installed.

- Open the Codex MCP configuration file or settings area.

- Add the Atlassian server using the command and args configuration above.

- Save the configuration.

- Restart Codex so it can launch the mcp-remote proxy.

- When the browser authentication window opens, sign in with your Atlassian account and approve access.

- Return to Codex and confirm the Atlassian Rovo MCP tools are available.

Important: Codex uses the mcp-remote proxy rather than a direct native HTTP connection. If authentication or tool discovery fails, first confirm that Node.js and npx are installed and available from your terminal.
Prerequisites:
- Claude Desktop installed.

- Node.js v18 or later installed.

- npx available on your machine.

- Access to edit the Claude Desktop configuration file.

- An Atlassian account with access to the Jira content you want to use.

Configuration:
{ "mcpServers": { "Atlassian": { "command": "npx", "args": ["-y", "mcp-remote@latest", "https://mcp.atlassian.com/v1/mcp/authv2"] } } }Steps:
- Confirm Node.js v18+ and npx are installed.

- Fully quit Claude Desktop before editing the configuration.

- Open the Claude Desktop configuration file.

- Find or create the mcpServers section.

- Add the Atlassian server using the Claude Desktop mcpServers configuration above.

- Save the configuration file.

- Restart Claude Desktop.

- Complete the Atlassian authentication flow when prompted.

- Open Claude Desktop and confirm the Atlassian Rovo MCP server appears in the available tools or integrations.

Important: Claude Desktop does not use the native HTTP servers block shown for GitHub Copilot. Use the mcpServers block with npx and mcp-remote.
Need help? See the IDE setup guide and troubleshooting.
CLI: In your agent terminal
Teamwork Graph CLI is a command line interface to the Atlassian Teamwork Graph and Cloud services.
If you work in terminals, scripts, or CI/CD pipelines, the Teamwork Graph CLI gives you deeper, command-line control of your Atlassian data.
Use this when you want an AI coding agent to install TWG CLI, authenticate, and set up agent skills for you.
Copy the following prompt and paste it into your agent:
Install/setup TWG using https://teamwork-graph.atlassian.com/cli/AGENTS.mdThe agent should use that hosted AGENTS.md directly. There are no separate agent-specific install URLs.
Once installed, run:
twg doctorThis checks authentication, connectivity, and build info. It works the same on macOS, Linux, PowerShell, and cmd
Want to install TWC CLI directly from your terminal? View the full TWG CLI setup guide.
Try it out:
Your AI coding agent can now access your Atlassian data across Jira, Confluence, Bitbucket, and more.
Describe what you want in plain language and your agent handles the rest:
- "Find all open bugs in [project name]."

- "Create a task titled 'Redesign onboarding', high priority, assign to me."

- "Move PROJ-456 to 'In Review' and add a comment that the PR is up."

- "Make 5 Jira work items from these meeting notes…"
