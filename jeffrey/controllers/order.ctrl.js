/**
 * Imports
 */

// Inner
const get = require("../helpers/get");
const string = require("../helpers/string");

const jeffrey = require("../models/jeffrey.model");
const order = require("../models/order.model");
const user = require("../models/user.model");

const options = require("../options");

/**
 * Config
 */

/**
 * Add
 */
exports.add = async event => {
  const { raw, rows } = await order.add(event.text, event.user);

  let author, diff, balance;
  if (!!rows) {
    author = await user.get(event.user);

    if (!author) {
      const profile = await jeffrey.getUser(event.user);
      if (profile) {
        author = await user.create(event.user, profile.name, profile.phone);
      }
    }

    if (author) {
      author.total = JSON.parse(author.total);

      const defaultBalance = Math.floor(
        author.balance / options.config.default.refill.amount
      );

      for (const type of raw.types) {
        author.total[type] = author.total[type]
          ? author.total[type] + raw[type]
          : raw[type];

        author.balance += raw[type] * options.config.orders[type].value;
      }

      diff =
        Math.floor(author.balance / options.config.default.refill.amount) -
        defaultBalance;

      balance =
        options.config.default.refill.amount -
        (author.balance % options.config.default.refill.amount);

      author.total = JSON.stringify(author.total);

      const update = user.update(author); // async
    }
  }

  const result = await jeffrey.say({
    url: event.response_url,
    channel: event.channel,
    user: event.user,
    blocks: [
      {
        textKey: `addOrder_${raw.types.length}`,
        data: raw.data
      }
    ],
    error: !rows || !author
  });

  if (!(!rows || !author)) {
    if (balance <= options.config.balance.warnAt) {
      const balanceWarn = jeffrey.say({
        channel: "dm",
        user: event.user,
        blocks: [
          {
            textKey: "autoWarnBalanceLow",
            data: {
              balance: balance,
              plural: balance > 1 ? "s" : ""
            }
          }
        ]
      });
    }
    console.log(diff);

    if (diff > 0) {
      const data = {
        user: event.user,
        amount: diff,
        plural: diff > 1 ? "s" : "",
        cost: (
          diff *
          options.config.default.refill.amount *
          options.config.default.refill.value
        ).toFixed(2)
      };
      // Notify admins
      for (const key in options.config.admins) {
        if (options.config.admins.hasOwnProperty(key)) {
          const admin = options.config.admins[key];
          jeffrey.say({
            channel: "dm",
            user: admin,
            blocks: [
              {
                textKey: "userMustRefill",
                data
              }
            ]
          });
        }
      }

      const lydiaWarn = await jeffrey.say({
        channel: "dm",
        user: event.user,
        blocks: [
          { textKey: "refillInfo", data },
          { key: "divider" },
          { textKey: "refillHowTo" },
          { key: "refillHowTo1", data },
          { key: "refillHowTo2", data },
          { key: "refillHowTo3", data }
        ]
      });
    }
  }

  order.prune();

  return !(!rows || !author);
};

/**
 * Stats
 */
exports.stats = async (event, data) => {
  let [channel, orders, author, users] = await Promise.all([
    jeffrey.getDMChannel(event.user),
    order.getAll(),
    order.getAllFromUser(event.user),
    user.getAll()
  ]);

  const blocks = [{ textKey: "statsIntro" }];

  const success = channel && !!orders && !!author && !!users;

  if (success) {
    blocks.push({ key: "divider" });

    const block = {
      key: "statsDetails",
      data: {}
    };

    orders = get.ordersObject(orders);
    author = get.ordersObject(author);

    const global = { total: 0 };
    for (const key in options.config.orders) {
      if (options.config.orders.hasOwnProperty(key)) {
        global[key] = 0;
      }
    }

    for (const user of users) {
      user.total = JSON.parse(user.total);
      user.total.total = 0;
      for (const key in options.config.orders) {
        if (options.config.orders.hasOwnProperty(key)) {
          const amount = user.total[key] || 0;
          user.total.total += amount;
          global[key] += amount;
          global.total += amount;
        }
      }
    }

    const usersOrders = users.map(i => ({
      ...i.total,
      name: i.name,
      uid: i.uid
    }));

    const theUser = usersOrders.find(i => i.uid === event.user) || { total: 0 };

    block.data = {
      g_total: orders.total,
      g_detail: get.detail(orders),
      g_total_overall: global.total,
      g_detail_overall: get.detail(global),
      u_total: author.total,
      u_detail: get.detail(author),
      u_total_overall: theUser.total,
      u_detail_overall: get.detail(theUser)
    };

    blocks.push(block);
    blocks.push({ key: "divider" });
    blocks.push({ textKey: "statsTop" });

    let fields = [
      get.top({
        users: usersOrders,
        key: "total",
        intro: "*:dancer: Overall:*",
        limit: 3
      })
    ];
    let count = 1;
    for (const key in options.config.orders) {
      if (options.config.orders.hasOwnProperty(key)) {
        fields.push(
          get.top({
            users: usersOrders,
            key,
            intro: `*${options.config.orders[key].emoji} ${string.ucFirst(
              key
            )}:*`,
            limit: 3
          })
        );
        if (++count === 2) {
          count = 0;
          blocks.push({
            type: "section",
            fields
          });
          fields = [];
        }
      }
    }
    if (count !== 0) {
      blocks.push({
        type: "section",
        fields
      });
    }
  }

  const result = await jeffrey.say({
    url: data === "dm" ? "" : event.response_url,
    channel: data === "dm" ? "dm" : event.channel,
    user: event.user,
    blocks,
    error: !success
  });

  const callback = data === "dm" ? await jeffrey.checkDM(event, channel) : true;

  return success;
};

/**
 * Cancel
 */
exports.cancel = async (event, data) => {
  let [orders, author] = await Promise.all([
    order.getLastFromUser(event.user),
    user.get(event.user)
  ]);

  const block = { textKey: "orderCancelled", data: {} };

  let success = orders.status !== 500 && !!author;

  if (success) {
    if (orders.status === 404) {
      block.textKey = "orderCancelledNotFound";
    } else {
      author.total = JSON.parse(author.total);
      for (const order of orders.rows) {
        author.total[order.type] -= order.amount;
        author.balance -= order.value;
      }
      author.total = JSON.stringify(author.total);

      const [updatedUser, updatedOrder] = await Promise.all([
        user.update(author),
        order.delFromUser(author.uid, orders.rows[0].time)
      ]);

      success = !!updatedUser;

      if (success) {
        block.data.balance =
          options.config.default.refill.amount -
          (updatedUser.balance % options.config.default.refill.amount);
      }
    }
  }

  const result = await jeffrey.say({
    url: event.response_url,
    channel: event.channel,
    user: event.user,
    blocks: [block],
    error: !success
  });

  return success;
};
