namespace QuoteCalculator
{
    public static class MoneyFormat
    {
        // KNOWN BUG, never fixed in the legacy: a negative amount loses its minus sign.
        // The new app has no negative amounts, so this is not a requirement. Do not copy it and do not fix it here.
        public static string Pounds(decimal amount) => "£" + System.Math.Abs(amount).ToString("N0");
    }
}
