using System;

namespace BookingCalculator
{
    public class BookingViewModel
    {
        public string Partner { get; set; } = "";
        public string LimitText { get; set; } = "";
        public string RateOnLineBasisPoints { get; set; } = "";

        // The legacy accepts limits up to 500,000,000.
        private const decimal MinLimit = 100000m;
        private const decimal MaxLimit = 500000000m;

        public string LimitError()
        {
            if (!decimal.TryParse(LimitText, out var limit))
                return "Limit must be a number.";
            if (limit < MinLimit || limit > MaxLimit)
                return "Limit must be between 100,000 and 500,000,000.";
            return null;
        }

        // Enabling order: the Limit box enables once a Partner is typed, the Rate box once the Limit is valid,
        // and Calculate once all three are valid.
        public bool LimitEnabled => Partner.Trim().Length > 0;
        public bool RateEnabled => LimitEnabled && LimitError() == null;
        public bool CalculateEnabled => RateEnabled && int.TryParse(RateOnLineBasisPoints, out var bps) && bps > 0 && bps <= 10000;

        // Summary line shown under the Calculate button.
        public string Summary(decimal fee) =>
            $"{Partner.Trim()}: rebated fee £{fee:N0}";
    }
}
