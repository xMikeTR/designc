workspace "Orders" {
  model {
    clerk = person "Order clerk"
    app = softwareSystem "Orders app" {
      list = container "OrdersList" {
        tags "UI"
      }
      api = container "Orders API"
    }
    clerk -> list "Tags orders"
    list -> api "Tags matching orders" {
      properties {
        d.interaction "sync"
      }
    }
  }
}
