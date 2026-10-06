workspace "Shop design" {
  model {
    shopper = person "Shopper"
    shop = softwareSystem "Shop" {
      api = container "Shop API"
      db = container "Orders DB"
    }
    shopper -> api "Orders"
    api -> db "Reads and writes"
  }
}
