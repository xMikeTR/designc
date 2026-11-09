using System;

namespace BookingCalculator
{
    // Rebated fee for a agreement booking. Money is whole pounds (decimal).
    public static class FeeCalculator
    {
        private const decimal MinimumFee = 5000m;

        // limit: whole pounds. rateOnLine: a fraction, 0.025m is 2.5% rate on line.
        public static decimal Rebated(decimal limit, decimal rateOnLine)
        {
            var raw = limit * rateOnLine;
            var rounded = Math.Round(raw, 0); // MidpointRounding.ToEven: 50012.5 becomes 50012
            return Math.Max(rounded, MinimumFee);
        }

        // Fee for the rest of the period after a renewal: pro rata by days, no minimum applied.
        public static decimal Renewal(decimal rebatedFee, int daysRemaining)
        {
            return Math.Round(rebatedFee * daysRemaining / 365m, 0);
        }
    }
}
