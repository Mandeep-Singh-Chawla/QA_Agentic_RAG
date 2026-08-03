# SCRUM-2: Connect your coding agent to Jira

- Type: Task
- Status: To Do
- Priority: n/a
- Assignee: Unassigned
- Updated: 2026-08-01T18:51:58.515+0530
- URL: https://mandeepsingh1986.atlassian.net/browse/SCRUM-2

## Description
Connect an agent to Jira to automate code changes, draft PRs, and progress work automatically.
Before setting up a coding agent, ensure you have:
- A Jira cloud instance with Rovo enabled.

- Admin rights to install a coding app, or submit a request to your admin.

- An active subscription for your chosen agent.

- A code repository the agent can work in.

Select your tool below to see setup steps:
- Go to the GitHub Copilot for Jira app on the Atlassian Marketplace.

- Select Get it now, choose your site, then review and install the app (or submit a request to your admin).

- If you're not automatically redirected, open the GitHub Copilot for Jira page on the GitHub Marketplace, sign in if required, and click Install.

- Back in Jira, go to Project settings → Apps → Manage apps.

- Find GitHub Copilot for Jira and select Configure.

- Enable the GitHub organisation you want to grant access to.

- In your Cursor integration settings, click Connect next to Jira.

- Go to the Cursor app on the Atlassian Marketplace.

- Select Get it now, choose your site, then review and install the app (or submit a request to your admin).

- Go to Project settings → Apps → Manage apps.

- Find Cursor and select Configure.

- Select Connect to Cursor.

- Connect your Jira site to your Cursor team.

The Claude for Jira coding agent requires two credentials:
- An Anthropic API key for Claude Managed Agents

- A GitHub personal access token for your GitHub service account

Once you have these:
- Go to the Claude for Jira app on the Atlassian Marketplace.

- Click Get it now, select your site, then review and install the app (or submit a request to your admin).

- Go to Project settings → Apps → Manage apps.

- Find Claude Agent for Jira and select Configure.

- In the Claude Managed Agents API Key field, paste your API key.

- Once verified, click Create Agent and confirm the Claude agent appears in your Anthropic Console.

- In the GitHub Personal Access Token field, paste and verify your access token.

- Click Save configuration.
