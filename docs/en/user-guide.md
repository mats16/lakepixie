# User Guide

This guide explains the user-facing features and how ccbricks works.

## Table of Contents

1. [Overview](#overview)
2. [File System and User Environment](#file-system-and-user-environment)
3. [Authentication and Permissions](#authentication-and-permissions)
4. [Skills System](#skills-system)
5. [Sessions and Workspace Integration](#sessions-and-workspace-integration)
6. [Security](#security)

## Overview

ccbricks is a Claude Code-like AI chat application running on Databricks Apps. Users can ask Claude to create code and perform Databricks workspace operations using natural language.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Databricks Apps                          │
│  ┌─────────────┐         ┌─────────────────────────────┐   │
│  │ Auth Proxy  │ headers │ ccbricks API               │   │
│  │             │────────▶│ ├─ /api/* (API)             │   │
│  │             │         │ └─ /*     (Frontend)        │   │
│  └─────────────┘         └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## File System and User Environment

### User Environment Isolation

In ccbricks, each user is assigned a dedicated file system area. This ensures data isolation between users.

```
${CCBRICKS_BASE_DIR}/
├── users/
│   ├── user1/                          # User 1's home directory
│   │   ├── .claude/
│   │   │   ├── settings.local.json     # Claude settings
│   │   │   └── skills/                 # User's skills
│   │   │       ├── my-skill/
│   │   │       │   └── SKILL.md
│   │   │       └── another-skill/
│   │   │           └── SKILL.md
│   │   └── ...
│   └── user2/                          # User 2's home directory
│       └── ...
├── sessions/
│   ├── session_xxx.../                 # Session working directory
│   └── session_yyy.../
└── db/
    └── ccbricks.sqlite                # SQLite database (dev fallback)
```

### Directory Roles

| Directory | Description |
|-----------|-------------|
| `${CCBRICKS_BASE_DIR}/users/${userId}` | User's home directory. User settings and skills are stored here |
| `${userHome}/.claude/` | Claude-related configuration files |
| `${userHome}/.claude/skills/` | Skills created or imported by the user |
| `${CCBRICKS_BASE_DIR}/sessions/${sessionId}` | Working directory for each session |
| `${CCBRICKS_BASE_DIR}/db/` | SQLite database directory (development) |

### Skills and File System

Skills are stored on the file system, which provides the following characteristics:

- **Persistence**: Skills are retained after session ends
- **User-specific**: Each user has their own set of skills
- **Portability**: Skills can be imported from Git repositories

## Authentication and Permissions

ccbricks uses different authentication methods depending on the type of operation.

### Authentication by Operation Type

| Category | Token Used | Description |
|----------|------------|-------------|
| **Claude Code Model** | OBO | Databricks-hosted Foundation Model API |
| **Databricks CLI (Claude execution)** | OBO | CLI commands like `databricks workspace import-dir`, app create/deploy |
| **Databricks SQL (MCP)** | OBO | Execute SQL with user permissions |

### Authentication Method Details

#### OBO (On-Behalf-Of) Token

A token automatically provided by the Databricks Apps authentication proxy. **No user action required** - it's available just by accessing the app.

- **Use case**: Claude Code foundation model calls, CLI commands executed by Claude, Databricks SQL execution via MCP
- **Permissions**: User's own Databricks permissions

#### Service Principal (SP)

A service account token configured in the application.

- **Use case**: App-internal Databricks API operations and telemetry helper authentication
- **Permissions**: Limited to permissions granted to the SP

## Skills System

### What are Skills?

Skills are custom instruction sets that extend Claude's capabilities. They are written in SKILL.md files and referenced by Claude when executing tasks.

### Skill Structure

```yaml
---
name: my-custom-skill
description: Description of this skill
metadata:
  version: 1.0.0
  author: your-name
  source: https://github.com/org/repo  # For Git imports
---

# Skill Content

Write instructions for Claude in Markdown format here.
```

### Skill Storage Location

Skills are stored in the user's file system area:

```
${userHome}/.claude/skills/
├── skill-name-1/
│   └── SKILL.md
└── skill-name-2/
    └── SKILL.md
```

### Skill Management

| Operation | Description |
|-----------|-------------|
| List | View registered skills |
| Create | Create new skill |
| Edit | Update existing skill content |
| Delete | Remove unwanted skills |
| Git Import | Import skills from public repositories |

### Import from Git

Skills can be imported from public Git repositories:

- **Supported formats**: HTTPS URL or SSH URL
- **Branch specification**: Can import from specific branch
- **Path specification**: Can specify specific directory within repository

### Backup/Restore to Workspace

You can backup skills to Databricks Workspace and restore them later. This enables skill persistence and sharing across devices.

#### Backup Destination

Skills are backed up to the following path:

```
/Workspace/Users/{username}/.assistant/skills/
```

#### How to Use

1. **Backup**: Select "Backup" from the split button on the skills management screen, then click "Start Backup" in the confirmation dialog
2. **Restore**: Select "Restore" from the split button dropdown, then click "Start Restore" in the confirmation dialog

#### Important Notes

- **OBO Token Used**: Backup/restore operations are executed with the user's OBO token
- **Overwrite Behavior**: Backup overwrites existing Workspace skills; restore overwrites existing local skills completely
- **Entire Directory**: The entire skills directory is synced, not individual skills

## Sessions and Workspace Integration

### How Sessions Work

Each chat session is assigned a dedicated working directory:

```
${userHome}/${sessionId}/
├── .claude/
│   └── settings.local.json  # SessionStart hook settings
├── imported_file1.py        # Files imported from Workspace
└── imported_file2.sql
```

### SessionStart Hooks

Commands that automatically execute at session start can be configured. When specifying Databricks Workspace as a source, the following command is automatically set:

```bash
databricks workspace export-dir "/Workspace/path/to/source" . --overwrite
```

This downloads Workspace files locally when the session starts.

### Workspace Operations Policy

In ccbricks, we adopt the policy of **having Claude Code perform** Workspace and app operations:

```
┌────────────────────────────────────────────────────────────────┐
│  Workspace Operation Flow                                      │
│                                                                │
│  User: "Fix this code and save it to Workspace"               │
│      ↓                                                         │
│  Claude: Edits the file                                        │
│      ↓                                                         │
│  Claude: Uploads to Workspace with databricks workspace import-dir │
│      ↓                                                         │
│  Claude: Reports "Done"                                        │
└────────────────────────────────────────────────────────────────┘
```

#### Benefits of This Approach

1. **Flexibility**: Claude selects optimal commands based on the situation
2. **Transparency**: Commands executed are shown to the user
3. **Error Handling**: Claude interprets and handles errors
4. **Learning**: Users can learn CLI usage

#### Main Databricks CLI Commands

Main CLI commands used by Claude within sessions:

| Command | Usage |
|---------|-------|
| `databricks workspace export-dir` | Download files from Workspace |
| `databricks workspace import-dir` | Upload files to Workspace |
| `databricks fs` | Unity Catalog Volumes operations |
| `databricks clusters` | Cluster management |
| `databricks jobs` | Job management |

## Security

### Data Isolation

#### Row-Level Security (RLS)

The database uses PostgreSQL RLS to restrict users to accessing only their own data:

- **Sessions**: Can only view own sessions
- **Tokens**: Can only manage own tokens
- **Settings**: Can only modify own settings

#### File System Isolation

- Each user's files are isolated under `${CCBRICKS_BASE_DIR}/users/${userId}`
- Validation implemented to prevent path traversal attacks
- Session deletion only removes the corresponding directory

### Token Protection

#### Encryption

Sensitive tokens are encrypted with AES-256-GCM:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key length**: 256 bits (64 hexadecimal characters)
- **IV**: Randomly generated for each encryption

#### Display Masking

When displaying tokens in the UI, they are partially masked:

```
dapi****xyz  (only first 4 + last 3 characters shown)
```

### Input Validation

#### Skill Names

- Allowed characters: `a-z`, `A-Z`, `0-9`, `-`, `_`
- Path separators (`/`, `\`) are prohibited
- `.` and `..` are prohibited

#### Git URLs

- Only URLs starting with `https://` or `git@` are allowed
- Branch name validation

### Session Security

- Session IDs are in TypeID format (UUIDv7-based)
- Independent working directory per session
- Cannot access other users' sessions

## Related Resources

- [Local Development Guide](./development.md) - Development environment setup
- [Deployment Guide](./deployment.md) - Deploying to Databricks Apps
