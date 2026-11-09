using Azure.Messaging.ServiceBus;

public sealed class EscalationHandler(ServiceBusClient client, IConfiguration config, IServiceProvider sp) : BackgroundService
{
    private readonly ServiceBusProcessor _processor = client.CreateProcessor(config["ServiceBus:EscalationQueue"]);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _processor.ProcessMessageAsync += async args =>
        {
            using var scope = sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<BookingsDbContext>();
            var booking = await db.Bookings.FindAsync(args.Message.Body.ToObjectFromJson<BookingId>().Value);
            booking!.Status = "Referred";          // no concurrency token: last write wins
            await db.SaveChangesAsync(ct);
        };
        await _processor.StartProcessingAsync(ct);
    }
}
