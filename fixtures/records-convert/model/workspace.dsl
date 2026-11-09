workspace {
  model {
    s = softwareSystem "Fares" {
      api = container "Fares API"
      db = container "Bookings DB"
      dbx = container "Bookings-DB"
      ui = container "Tags UI" { tags "UI" }
    }
  }
}
