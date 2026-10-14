var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("Vendor", c =>
    c.BaseAddress = new Uri(builder.Configuration["Vendor:BaseUrl"]!))
    .AddStandardResilienceHandler();   // retries: the vendor run is not idempotent
var app = builder.Build();
app.MapPost("/modelled-loss", () => Results.Ok());
app.Run();
