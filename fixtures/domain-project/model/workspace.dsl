workspace "Quotes" {
  model {
    broker = person "Broker"
    quotes = softwareSystem "Quotes" {
      api = container "Quotes API" "Prices a quote" "ASP.NET Core" {
        properties {
          "d.owns" "Quote"
        }
      }
    }
    broker -> api "Requests a quote" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
