// The only place shared external/store names live, so C# and JS scanners converge on one
// element per real system instead of inventing their own spellings.
module.exports = {
  ENTRA_ID: { name: 'Entra ID', kind: 'external', tech: 'Identity provider' },
  KEY_VAULT: { name: 'Key Vault', kind: 'store', tech: 'Azure Key Vault' },
  SNOWFLAKE: { name: 'Snowflake', kind: 'store', tech: 'Snowflake' },
  NEW_RELIC: { name: 'New Relic', kind: 'external', tech: 'Observability' },
  APPLICATION_INSIGHTS: { name: 'Application Insights', kind: 'external', tech: 'Observability' },
  SQL_SERVER: { name: 'SQL Server', kind: 'store', tech: 'SQL Server' },
  POSTGRESQL: { name: 'PostgreSQL', kind: 'store', tech: 'PostgreSQL' },
  REDIS: { name: 'Redis', kind: 'store', tech: 'Redis' },
  BLOB_STORAGE: { name: 'Blob Storage', kind: 'store', tech: 'Azure Blob Storage' },
  COSMOS_DB: { name: 'Cosmos DB', kind: 'store', tech: 'Cosmos DB' },
  MONGO_DB: { name: 'MongoDB', kind: 'store', tech: 'MongoDB' },
  MYSQL: { name: 'MySQL', kind: 'store', tech: 'MySQL' },
  SERVICE_BUS: { name: 'Azure Service Bus', kind: 'external', tech: 'Messaging' },
  ANTHROPIC: { name: 'Anthropic API', kind: 'external', tech: 'LLM API' },
  OPENAI: { name: 'OpenAI API', kind: 'external', tech: 'LLM API' },
};
