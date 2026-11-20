workspace "RE Fares Engine" {
  model {
    traveller = person "Traveller" {
      properties {
        "d.zone" "corporate"
      }
    }
    catVendor = softwareSystem "Weather Feed Vendor" {
      tags "External"
      properties {
        "d.aka" "api.weatherfeed-vendor.com"
        "d.zone" "vendor"
        "d.availability" "0.995"
      }
    }
    !include fares.dsl
    !include relationships.dsl
  }
}
