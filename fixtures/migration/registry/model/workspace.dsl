workspace "Treaty quote" {
  model {
    underwriter = person "Underwriter"
    quotes = softwareSystem "Treaty Quotes" {
      app = container "Quote App" "Prices a treaty quote in the browser" "React" {
        pricing = component "Pricing" "Ceded and reinstatement premium" "TypeScript" {
          properties {
            "d.code" "src/pricing/**"
            "d.risk" "high"
          }
        }
        validation = component "Validation" "Limit and field rules" "TypeScript" {
          properties {
            "d.code" "src/validation/**"
            "d.risk" "medium"
          }
        }
        summary = component "Summary" "The line under Calculate" "TypeScript" {
          properties {
            "d.code" "src/summary/**"
            "d.risk" "low"
          }
        }
      }
    }
    underwriter -> app "Requests a quote" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
