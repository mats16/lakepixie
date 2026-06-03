# Deployment Guide

This guide explains how to deploy ccbricks to Databricks Apps.

## Prerequisites

- Databricks CLI installed and configured
- Access to a Databricks workspace with Apps enabled
- A Databricks workspace in a Lakebase-supported region when using Lakebase

## 1. Database Setup

### 1.1 Lakebase Mode

DAB (Databricks Asset Bundles) creates the Lakebase Postgres project and binds it
to the app as the `lakebase` resource. You do not need to manually create a
Lakebase resource or manage database connection secrets.

When using Lakebase, confirm these settings are enabled:

- The `lakebase` binding in `resources.apps.ccbricks_app.resources` in [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml)
- `resources.postgres_projects.ccbricks_db` in [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml)
- The `LAKEBASE_ENDPOINT` environment variable in [app.yaml](../../app.yaml)

Databricks Apps injects the PostgreSQL connection variables (`PGAPPNAME`,
`PGDATABASE`, `PGHOST`, `PGPORT`, `PGSSLMODE`, and `PGUSER`) for the bound
resource.
On startup, the API creates an app-specific PostgreSQL schema named
`{PGAPPNAME}_schema_{PGUSER-without-hyphens}` and runs migrations with
`search_path` set to that schema.

### 1.2 SQLite Mode for Regions Without Lakebase

When deploying to a region that does not support Lakebase, comment out the
Lakebase DAB definitions and the `LAKEBASE_ENDPOINT` injection.

1. Comment out `LAKEBASE_ENDPOINT` in [app.yaml](../../app.yaml).

```yaml
#- name: LAKEBASE_ENDPOINT
#  valueFrom: lakebase
```

2. Comment out the app's `lakebase` binding in [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml).

```yaml
#resources:
#  - name: lakebase
#    postgres:
#      branch: ${resources.postgres_projects.ccbricks_db.id}/branches/production
#      database: ${resources.postgres_projects.ccbricks_db.id}/branches/production/databases/databricks-postgres
#      permission: CAN_CONNECT_AND_CREATE
```

3. Comment out the `postgres_projects` definition in the same [resources/ccbricks.app.yaml](../../resources/ccbricks.app.yaml).

```yaml
#postgres_projects:
#  ccbricks_db:
#    project_id: ccbricks-db-${bundle.target}
```

When `LAKEBASE_ENDPOINT` is not injected, the API starts in SQLite mode. In
Databricks Apps, `CCBRICKS_BASE_DIR=/home/app`, so the SQLite database is created
at `/home/app/db/ccbricks.sqlite`.

### 1.3 Application User

When the Lakebase resource is attached, Databricks creates or reuses a PostgreSQL
role for the app service principal and grants it connect/create privileges.

**Important:** The application uses Row-Level Security (RLS) with `current_setting('app.user_id', true)`. The application sets this session variable for each request to enforce user isolation.

SQLite mode does not use PostgreSQL RLS. Use it as a fallback or validation mode
for regions that do not support Lakebase.

### 1.4 Database Migrations

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

You do not need to create or manage secrets for Lakebase connectivity. GitHub
OAuth client secrets and application encryption keys are stored by the app in the
Databricks Secrets app scope.

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

1. In Lakebase mode, verify the `lakebase` resource binding injects `LAKEBASE_ENDPOINT` and `PG*`
2. In SQLite mode, verify `LAKEBASE_ENDPOINT` is commented out and `/home/app/db` is writable
3. Check network connectivity between Databricks Apps and Lakebase
4. Ensure the app service principal has connect/create permissions

### Migration Failures

1. In Lakebase mode, ensure the app service principal can create objects in the app schema
2. In SQLite mode, ensure the SQLite file and `db` directory are writable
3. Check for existing objects that might conflict
4. Review the migration SQL files for errors

### Application Startup Issues

1. Check application logs in Databricks Apps console
2. Verify the app has permission to create/update its app secret scope
3. Ensure the build completed successfully before deployment

## Environment-Specific Configuration

| Setting        | Development                           | Production                      |
| -------------- | ------------------------------------- | ------------------------------- |
| Bundle Target  | `dev`                                 | `prod`                          |
| Database       | Lakebase or SQLite                    | Lakebase or SQLite              |
| App Name       | `ccbricks-dev-<user-id>`              | `ccbricks-prod`                 |
| Workspace Path | `/Workspace/Users/<user>/.bundle/...` | `/Workspace/Shared/.bundle/...` |

## Security Considerations

1. **Lakebase permissions:** Use the app service principal created and bound by DAB, and keep environment resources separated
2. **Encryption keys:** Generate unique keys for each environment
3. **Secret scopes:** Restrict access to the app secret scope appropriately
4. **Network security:** Configure private endpoints where possible
