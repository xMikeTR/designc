workspace {
  model {
    s = softwareSystem "Pricing" {
      api = container "Pricing API"
      db = container "Quotes DB"
      dbx = container "Quotes-DB"
      ui = container "Tags UI" { tags "UI" }
    }
  }
}
