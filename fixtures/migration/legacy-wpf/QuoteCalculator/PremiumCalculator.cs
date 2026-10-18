using System;

namespace QuoteCalculator
{
    // Ceded premium for a treaty quote. Money is whole pounds (decimal).
    public static class PremiumCalculator
    {
        private const decimal MinimumPremium = 5000m;

        // limit: whole pounds. rateOnLine: a fraction, 0.025m is 2.5% rate on line.
        public static decimal Ceded(decimal limit, decimal rateOnLine)
        {
            var raw = limit * rateOnLine;
            var rounded = Math.Round(raw, 0); // MidpointRounding.ToEven: 50012.5 becomes 50012
            return Math.Max(rounded, MinimumPremium);
        }

        // Premium for the rest of the period after a reinstatement: pro rata by days, no minimum applied.
        public static decimal Reinstatement(decimal cededPremium, int daysRemaining)
        {
            return Math.Round(cededPremium * daysRemaining / 365m, 0);
        }
    }
}
