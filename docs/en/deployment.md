# Deployment Guide

This guide explains how to deploy ccbricks to Databricks Apps.

## Prerequisites

- Databricks CLI installed and configured
- Access to a Databricks workspace with Apps enabled
- Databricks Lakebase resource for persistent database storage

## 1. Database Setup

### 1.1 Create Lakebase Resource

The bundle defines a Lakebase Postgres project and binds it to the app as the
`lakebase` resource. Databricks Apps injects the PostgreSQL connection variables
(`PGAPPNAME`, `PGDATABASE`, `PGHOST`, `PGPORT`, `PGSSLMODE`, and `PGUSER`) for the
bound resource.
On startup, the API creates an app-specific PostgreSQL schema named
`{PGAPPNAME}_schema_{PGUSER-without-hyphens}` and runs migrations with
`search_path` set to that schema.

### 1.2 Application User

When the Lakebase resource is attached, Databricks creates or reuses a PostgreSQL
role for the app service principal and grants it connect/create privileges.

**Important:** The application uses Row-Level Security (RLS) with `current_setting('app.user_id', true)`. The application sets this session variable for each request to enforce user isolation.

### 1.3 Database Migrations

Database migrations are automatically applied when the server starts. No manual migration steps are required for deployment.

Automatic migrations are disabled in the following cases:

- When environment variable `DISABLE_AUTO_MIGRATION=true` is set
- When environment variable `NODE_ENV=test` is set

**For local development or manual migration:**

```bash
# Use Lakebase mode
export LAKEBASE_ENDPOINT="projects/.../branches/.../endpoints/..."
export PGAPPNAME="ccbricks"
export PGDATABASE="databricks-postgres"
export PGHOST="..."
export PGPORT="5432"
export PGSSLMODE="require"
export PGUSER="service-principal-client-id"

# Navigate to api directory
cd apps/api

# Generate migration files (if schema changed)
npm run db:generate

# Manually apply migrations (optional)
npm run db:migrate
```

## 2. Configure Secrets

Create a Databricks secret scope and add required secrets.

### 2.1 Create Secret Scope

```bash
# Development
databricks secrets create-scope ccbricks-dev

# Production
databricks secrets create-scope ccbricks-prod
```

### 2.2 Add Required Secrets

GitHub OAuth client secrets and application encryption keys are stored in Databricks Secrets.
The app writes the following keys to the app secret scope:

- `github-oauth-client-secret` from the Admin UI
- `encryption-active-key-version` automatically when missing
- `encryption-key-v<version>` automatically when missing or when rotated

Grant the app service principal permission to create/read/write secrets for the app scope.

## 3. Deploy with Asset Bundles

> **Default Target:** The `databricks.yaml` is configured to use `dev` as the default target. You can omit `--target` for development deployments.

### 3.1 Validate Bundle Configuration

```bash
databricks bundle validate [--target prod]
```

### 3.2 Deploy to Databricks

```bash
databricks bundle deploy [--target prod]
```

### 3.3 Start Application

```bash
databricks bundle run ccbricks_app [--target prod]
```

### 3.4 Verify Deployment

After deployment, check the application status:

```bash
# List deployed apps
databricks apps list

# Get app details
databricks apps get ccbricks-dev-<user-id>
```

## Troubleshooting

### Database Connection Issues

1. Verify the `lakebase` resource binding injects `LAKEBASE_ENDPOINT` and `PG*`
2. Check network connectivity between Databricks Apps and Lakebase
3. Ensure the app service principal has connect/create permissions

### Migration Failures

1. Ensure the app service principal can create objects in the app schema
2. Check for existing objects that might conflict
3. Review the migration SQL files for errors

### Application Startup Issues

1. Check application logs in Databricks Apps console
2. Verify all required secrets are configured
3. Ensure the build completed successfully before deployment

## Environment-Specific Configuration

| Setting        | Development                           | Production                      |
| -------------- | ------------------------------------- | ------------------------------- |
| Bundle Target  | `dev`                                 | `prod`                          |
| Secret Scope   | `ccbricks-dev`                        | `ccbricks-prod`                 |
| App Name       | `ccbricks-dev-<user-id>`              | `ccbricks-prod`                 |
| Workspace Path | `/Workspace/Users/<user>/.bundle/...` | `/Workspace/Shared/.bundle/...` |

## Security Considerations

1. **Lakebase permissions:** Use the app service principal and keep environment resources separated
2. **Encryption keys:** Generate unique keys for each environment
3. **Secret scopes:** Restrict access to secret scopes appropriately
4. **Network security:** Configure private endpoints where possible
