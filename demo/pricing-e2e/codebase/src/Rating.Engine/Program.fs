open System
open Microsoft.AspNetCore.Builder
open Microsoft.Extensions.DependencyInjection
open StackExchange.Redis

let builder = WebApplication.CreateBuilder()
builder.Services.AddHttpClient("CatModel", fun (c: Net.Http.HttpClient) ->
    c.BaseAddress <- Uri(builder.Configuration["Services:CatModelAdapter"])) |> ignore
// Legacy: rates cache kept from the old pricing system
let cache = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("LegacyRatesCache"))
let app = builder.Build()
app.MapPost("/rate", Func<_>(fun () -> "rated")) |> ignore
app.Run()
