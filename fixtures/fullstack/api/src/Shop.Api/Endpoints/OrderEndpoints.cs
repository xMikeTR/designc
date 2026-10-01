namespace Shop.Api.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        var orders = app.MapGroup("/orders");

        orders.MapGet("/{id}", (string id) => Results.Ok(new { id }));
        orders.MapPost("", (OrderRequest request) => Results.Created());
    }
}

public record OrderRequest(string Sku, int Quantity);
