using Snowflake.Data.Client;

namespace Shop.Infrastructure;

public class Warehouse
{
    private readonly string _connectionString;

    public Warehouse(string connectionString)
    {
        _connectionString = connectionString;
    }

    public SnowflakeDbConnection OpenConnection()
    {
        var conn = new SnowflakeDbConnection(_connectionString);
        conn.Open();
        return conn;
    }
}
