using Azure.Messaging.ServiceBus;

public sealed class ReferralHandler(ServiceBusClient client, IConfiguration config, IServiceProvider sp) : BackgroundService
{
    private readonly ServiceBusProcessor _processor = client.CreateProcessor(config["ServiceBus:ReferralQueue"]);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _processor.ProcessMessageAsync += async args =>
        {
            using var scope = sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<QuotesDbContext>();
            var quote = await db.Quotes.FindAsync(args.Message.Body.ToObjectFromJson<QuoteId>().Value);
            quote!.Status = "Referred";          // no concurrency token: last write wins
            await db.SaveChangesAsync(ct);
        };
        await _processor.StartProcessingAsync(ct);
    }
}
