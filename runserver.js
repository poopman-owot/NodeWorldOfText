const https         = require("https");
const http          = require("http"); // just in case the keys don't exist
const url           = require("url");
const sql           = require("sqlite3").verbose();
const fs            = require("fs");
const swig          = require("swig");
const querystring   = require("querystring");
const crypto        = require("crypto");
const mime          = require("./backend/mime.js");
const prompt        = require("prompt");
const dump_dir      = require("./backend/dump_dir");
const zip           = require("adm-zip")
const nodemailer    = require("nodemailer");
const ws            = require("ws");

const settings = require("./settings.json");
const database = new sql.Database(settings.DATABASE_PATH);

Error.stackTraceLimit = Infinity;

var static_path = "./frontend/static/";
var static_path_web = "static/"

var template_data = {}; // data used by the server
var templates_path = "./frontend/templates/";
dump_dir(template_data, templates_path, "", true);
for(var i in template_data) {
    template_data[i] = swig.compileFile(template_data[i]);
}

var static_data = {}; // html data to be returned (text data for values)
dump_dir(static_data, static_path, static_path_web);

var sql_table_init = "./backend/default.sql";
var sql_indexes_init = "./backend/indexes.sql";

var zip_file;
if(!fs.existsSync(settings.ZIP_LOG_PATH)) {
    zip_file = new zip();
} else {
    zip_file = new zip(settings.ZIP_LOG_PATH);
}
if(fs.existsSync(settings.LOG_PATH)) {
    var file = fs.readFileSync(settings.LOG_PATH)
    if(file.length > 0) {
        var log_data = fs.readFileSync(settings.LOG_PATH);
        zip_file.addFile("NWOT_LOG_" + Date.now() + ".txt", log_data, "", 0644);
        fs.truncateSync(settings.LOG_PATH);
    }
}
zip_file.writeZip(settings.ZIP_LOG_PATH);

// load all modules from directory. EG: "test.js" -> "test"
function load_modules(default_dir) {
    var pages = fs.readdirSync(default_dir)
    var obj = {};
    for(var i = 0; i < pages.length; i++) {
        var name = pages[i].split(".js")[0];
        obj[name] = require(default_dir + pages[i]);
    }
    return obj;
}

const pages = load_modules("./backend/pages/");
const websockets = load_modules("./backend/websockets/");
const modules = load_modules("./backend/modules/");

const db = {
    // gets data from the database (only 1 row at a time)
    get: async function(command, params) {
        if(params == void 0 || params == null) params = []
        return new Promise(function(r, rej) {
            database.get(command, params, function(err, res) {
                if(err) {
                    return rej({
                        sqlite_error: process_error_arg(err),
                        input: { command, params }
                    })
                }
                r(res)
            })
        })
    },
    // runs a command (insert, update, etc...) and might return "lastID" if needed
    run: async function(command, params) {
        if(params == void 0 || params == null) params = []
        var err = false
        return new Promise(function(r, rej) {
            database.run(command, params, function(err, res) {
                if(err) {
                    return rej({
                        sqlite_error: process_error_arg(err),
                        input: { command, params }
                    })
                }
                var info = {
                    lastID: this.lastID
                }
                r(info)
            })
        })
    },
    // gets multiple rows in one command
    all: async function(command, params) {
        if(params == void 0 || params == null) params = []
        return new Promise(function(r, rej) {
            database.all(command, params, function(err, res) {
                if(err) {
                    return rej({
                        sqlite_error: process_error_arg(err),
                        input: { command, params }
                    })
                }
                r(res)
            })
        })
    },
    // get multiple rows but execute a function for every row
    each: async function(command, params, callbacks) {
        if(typeof params == "function") {
            callbacks = params
            params = []
        }
        var def = callbacks
        var callback_error = false
        var cb_err_desc = "callback_error...";
        callbacks = function(e, data) {
            try {
                def(data)
            } catch(e) {
                callback_error = true
                cb_err_desc = e;
            }
        }
        return new Promise(function(r, rej) {
            database.each(command, params, callbacks, function(err, res) {
                if(err) return rej({
                    sqlite_error: process_error_arg(err),
                    input: { command, params }
                })
                if(callback_error) return rej(cb_err_desc)
                r(res)
            })
        })
    },
    // like run, but executes the command as a SQL file
    // (no comments allowed, and must be semicolon seperated)
    exec: async function(command) {
        return new Promise(function(r, rej) {
            database.exec(command, function(err) {
                if(err) {
                    return rej({
                        sqlite_error: process_error_arg(err),
                        input: { command }
                    })
                }
                r(true)
            })
        })
    }
};

var transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: settings.email.username,
        pass: settings.email.password
    }
});
var email_available = true;
try {
    transporter.verify()
} catch(e) {
    email_available = false;
    console.log("Email is disabled because the verification failed (credentials possibly incorrect)")
}

async function send_email(destination, subject, text) {
    if(!email_available) return false;
    var options = {
        from: settings.email.display_email,
        to: destination,
        subject: subject,
        html: text
    };
    return new Promise(function(resolve) {
        transporter.sendMail(options, function(error, info) {
            if (error) {
                resolve("error");
            } else {
                resolve(info);
            }
        });
    })
}

var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function create_date(time) {
	var str = "(UTC) ";
	
	var date = new Date(time);
	var month = date.getUTCMonth();
	str += months[month] + " ";
	
	var day = date.getUTCDate();
	str += day + ", "
	
	var year = date.getUTCFullYear();
	str += year + " "
	
	var hour = date.getUTCHours() + 1;
	var ampm = " AM"
	if(hour >= 12) {
		ampm = " PM"
	}
	if(hour > 12) {
		hour = hour - 12
	}
	if(hour === 0) {
		hour = 12;
	}
	str += hour
	
	var minute = date.getUTCMinutes();
	minute = ("0" + minute).slice(-2);
	str += ":" + minute
	
	var second = date.getUTCSeconds();
	second = ("0" + second).slice(-2);
	str += ":" + second + ampm
	
	return str;
}

// sanitize number input
function san_nbr(x) {
    x -= 0;
    if(x >= 9007199254740991) x = 9007199254740991;
    if(x <= -9007199254740991) x = -9007199254740991;
    x = parseInt(x);
    if(!x || isNaN(x) || !isFinite) {
        x = 0;
    }
    x = Math.floor(x);
    if(x >= 9007199254740991) x = 9007199254740991;
    if(x <= -9007199254740991) x = -9007199254740991;
    return x;
}

var announcement_cache = "";

async function initialize_server() {
    console.log("Starting server...");
    if(!await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='server_info'")) {
        // table to inform that the server is initialized
        await db.run("CREATE TABLE 'server_info' (name TEXT, value TEXT)");
    }
    var init = false;
    if(!await db.get("SELECT value FROM server_info WHERE name='initialized'")) {
        // server is not initialized
        console.log("Initializing server...");
        await db.run("INSERT INTO server_info VALUES('initialized', 'true')");

        var tables = fs.readFileSync(sql_table_init).toString();
        var indexes = fs.readFileSync(sql_indexes_init).toString();

        await db.exec(tables)
        await db.exec(indexes)

        init = true;
        account_prompt();
    }
    if(!init) {
        start_server();
    }
}

(async function() {
    try {
        await initialize_server();
    } catch(e) {
        console.log("An error occured during the initialization process:");
        console.log(e)
    }
})()

prompt.message      = ""; // do not display "prompt" before each question
prompt.delimiter    = ""; // do not display ":" after "prompt"
prompt.colors       = false; // disable dark gray color in a black console

var prompt_account_properties = {
    properties: {
        username: {
            message: "Username: "
        },
        password: {
            description: "Password: ",
            replace: "*",
            hidden: true
        },
        confirmpw: {
            description: "Password (again): ",
            replace: "*",
            hidden: true
        }
    }
};

var prompt_account_yesno = {
    properties: {
        yes_no_account: {
            message: "You just installed the server,\nwhich means you don\'t have any superusers defined.\nWould you like to create one now? (yes/no):"
		}
	}
};

const log_error = function(err) {
	if(settings.error_log) {
		try {
			err = JSON.stringify(err);
			err = "TIME: " + Date.now() + "\r\n" + err + "\r\n" + "-".repeat(20) + "\r\n\r\n\r\n";
			fs.appendFileSync(settings.LOG_PATH, err);
		} catch(e) {
			console.log("Error logging error:", e)
		}
	}
}

var pw_encryption = "sha512WithRSAEncryption";
const encryptHash = function(pass, salt) {
	if(!salt) {
		var salt = crypto.randomBytes(10).toString("hex")
	}
	var hsh = crypto.createHmac(pw_encryption, salt).update(pass).digest("hex")
	var hash = pw_encryption + "$" + salt + "$" + hsh;
	return hash;
};

const checkHash = function(hash, pass) {
	if(typeof hash !== "string") return false;
	hash = hash.split("$");
	if(hash.length !== 3) return false;
	if(typeof pass !== "string") return false;
	return encryptHash(pass, hash[1]) === hash.join("$");
};

// just to make things easier
function toUpper(x) {
    return x.toString().toUpperCase();
}

function add(username, level) {
    level = parseInt(level);
    if(!level) level = 0;
    level = Math.trunc(level);
    if(level < 0) level = 0;
    if(level >= 3) level = 3;
    var Date_ = Date.now();
    ask_password = true;
    account_to_create = username;
    (async function() {
        try {
            await db.run("INSERT INTO auth_user VALUES(null, ?, '', ?, 1, ?, ?, ?)",
                [username, "", level, Date_, Date_])
        } catch(e) {
            console.log(e);
        }
    })();
}

function account_prompt() {
    passFunc = function(err, result) {
		var err = false;
		if(result["password"] !== result["confirmpw"]) {
			console.log("Error: Your passwords didn't match.")
			err = true;
			prompt.get(prompt_account_properties, passFunc);
		} else if(result.password.length > 128) {
			console.log("The password is too long. It must be 128 characters or less.");
			err = true;
			prompt.get(prompt_account_properties, passFunc);
		}
		
		if(!err) {
			var Date_ = Date.now()
            var passHash = encryptHash(result["password"])

            db.run("INSERT INTO auth_user VALUES(null, ?, '', ?, 1, 3, ?, ?)",
                [result["username"], passHash, Date_, Date_])

            console.log("Superuser created successfully.\n");
            start_server();
		}
	}
	yesNoAccount = function(err, result) {
		var re = result["yes_no_account"];
		if(toUpper(re) === "YES") {
			prompt.get(prompt_account_properties, passFunc);
		}
		if(toUpper(re) === "NO") {
			start_server()
		}
		if(toUpper(re) !== "YES" && toUpper(re) !== "NO") {
			console.log("Please enter either \"yes\" or \"no\" (not case sensitive):");
			prompt.get(prompt_account_yesno, yesNoAccount);
		}
    }
    prompt.start();
    prompt.get(prompt_account_yesno, yesNoAccount);
}

var prompt_command_input = {
    properties: {
        input: {
            message: ">>"
		}
	}
};

var prompt_password_new_account = {
    properties: {
        password: {
            message: "Enter password for this account: ",
            replace: "*",
            hidden: true
		}
	}
};

var ask_password = false;
var account_to_create = "";

function command_prompt() {
    function on_input(err, input) {
        if(err) return console.log(err);
        try {
            console.dir(eval(input.input), { colors: true });
        } catch(e) {
            console.dir(e, { colors: true });
        }
        command_prompt();
    }
    function on_password_input(err, input) {
        if(err) return console.log(err);
        if(account_to_create == void 0) return;
        var pass = input.password;
        db.run("UPDATE auth_user SET password=? WHERE username=?",
            [encryptHash(pass), account_to_create])
        account_to_create = void 0;
        command_prompt();
    }
    prompt.start();
    if(!ask_password) {
        prompt.get(prompt_command_input, on_input);
    } else {
        ask_password = false;
        prompt.get(prompt_password_new_account, on_password_input)
    }
}

//Time in milliseconds
var Second = 1000;
var Minute = 60000;
var Hour   = 3600000;
var Day    = 86400000;
var Week   = 604800000;
var Month  = 2628002880;
var Year   = 31536034560;
var Decade = 315360345600;

var ms = { Second, Minute, Hour, Day, Week, Month, Year, Decade };

var url_regexp = [ // regexp , function/redirect to
    ["^(\\w*)$", pages.yourworld],
    ["^(beta/(.*))$", pages.yourworld],
    ["^(frontpage/(.*))$", pages.yourworld],
    ["^favicon\.ico$", "/static/favicon.png"],
    ["^home/$", pages.home],
    ["^accounts/login", pages.login],
    ["^accounts/logout", pages.logout],
    ["^accounts/register/$", pages.register],
    ["^ajax/protect/$", pages.protect],
    ["^ajax/unprotect/$", pages.unprotect],
    ["^ajax/coordlink/$", pages.coordlink],
    ["^ajax/urllink/$", pages.urllink],
    ["^accounts/profile/", pages.profile],
    ["^accounts/private/", pages.private],
    ["^accounts/configure/$", pages.configure], // for front page configuring
    ["^accounts/configure/(.*)/$", pages.configure],
    ["^accounts/configure/(beta/\\w+)/$", pages.configure],
    ["^accounts/member_autocomplete/$", pages.member_autocomplete],
    ["^accounts/timemachine/(.*)/$", pages.timemachine],
    ["^accounts/register/complete/$", pages.register_complete],
    ["^accounts/activate/(.*)/$", pages.activate],
    ["^administrator/$", pages.administrator],
    ["^administrator/edits/$", pages.administrator_edits], // for front page downloading
    ["^administrator/edits/(.*)/$", pages.administrator_edits],
    ["^script_manager/$", pages.script_manager],
    ["^script_manager/edit/(.*)/$", pages.script_edit],
    ["^script_manager/view/(.*)/$", pages.script_view],
    ["^administrator/user/(.*)/$", pages.administrator_user],
    ["^accounts/download/$", pages.accounts_download], // for front page downloading
    ["^accounts/download/(.*)/$", pages.accounts_download],
    ["^world_style/$", pages.world_style]
]

function get_third(url, first, second) {
    var value = split_limit(url, first + "/" + second + "/", 1)[1]
    if(value.charAt(value.length - 1) === "/") {
        value = value.substring(0, value.length - 1);
    }
    return value;
}

/*
    dispatch page
    usage: this is to be used in the page modules when
    the module wants to dispatch a different page module.
    EG: return dispage("404", { extra parameters for page }, req, serve, vars, "POST")
    (req, serve, and vars should already be defined by the parameters)
    ("POST" is only needed if you need to post something. otherwise, don't include anything)
*/
async function dispage(page, params, req, serve, vars, method) {
    if(!method) {
        method = "GET";
    }
    method = method.toUpperCase();
    if(!params) {
        params = {};
    }
    if(!vars) {
        vars = {};
    }
    await pages[page][method](req, serve, vars, params);
}

var static_file_returner = {}
static_file_returner.GET = function(req, serve) {
    var parse = url.parse(req.url).pathname.substr(1)
    var mime_type = mime(parse.replace(/.*[\.\/\\]/, "").toLowerCase());
    serve(static_data[parse], 200, { mime: mime_type })
}

// push static file urls to regexp array
for (var i in static_data) {
    url_regexp.push(["^" + i + "$", static_file_returner])
}

// trim whitespaces in all items in array
function ar_str_trim(ar) {
    for(var i = 0; i < ar.length; i++) {
        ar[i] = ar[i].trim();
    }
    return ar;
}

function ar_str_decodeURI(ar) {
    for(var i = 0; i < ar.length; i++) {
        ar[i] = decodeURIComponent(ar[i]);
    }
    return ar;
}

/*
    usage:
    split_limit("a|b|c|d|e|f|g", "|", 3) = ["a", "b", "c", "d|e|f|g"]
*/
function split_limit(str, char, limit) {
    if(!limit && limit != 0) limit = Infinity;
    var arr = str.split(char)
    var result = arr.splice(0, limit);
    result.push(arr.join(char));
    return result;
}

function parseCookie(cookie) {
    try {
        if(typeof cookie !== "string") {
            return {};
        }
        cookie = cookie.split(";");
        var result = {};
        for(var i = 0; i < cookie.length; i++) {
            var seg = cookie[i];
            seg = split_limit(seg, "=", 1);
            seg = ar_str_trim(seg)
            seg = ar_str_decodeURI(seg);
            if(seg.length == 1) {
                if(seg[0] == "") continue;
                result[seg[0]] = 1;
            } else {
                result[seg[0]] = seg[1];
            }
        }
        return result;
    } catch(e) {
        return {};
    }
}

var filename_sanitize = (function() { // do not pollute global scope
	var illegalRe = /[\/\?<>\\:\*\|":]/g;
	var controlRe = /[\x00-\x1f\x80-\x9f]/g;
	var reservedRe = /^\.+$/;
	var windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
	var windowsTrailingRe = /[\. ]+$/;

	function sanitize(input, replacement) {
		var sanitized = input
			.replace(illegalRe, replacement)
			.replace(controlRe, replacement)
			.replace(reservedRe, replacement)
			.replace(windowsReservedRe, replacement)
			.replace(windowsTrailingRe, replacement);
		return sanitized;
	}

	return function(input, options) {
		var replacement = "_";
		return sanitize(input, replacement);
	}
})()

function objIncludes(defaultObj, include) {
    var new_obj = {};
    for(var i in defaultObj) {
        new_obj[i] = defaultObj[i]
    }
    for(var i in include) {
        new_obj[i] = include[i];
    }
    return new_obj;
}

function wait_response_data(req, dispatch) {
    var queryData = ""
    var error = false;
    return new Promise(function(resolve) {
        req.on("data", function(data) {
            queryData += data;
            if (queryData.length > 10000000) {
                queryData = "";
                dispatch("Payload too large", 413)
                error = true
                resolve(null);
            }
        });
        req.on("end", function() {
            if(!error) {
                try {
                    resolve(querystring.parse(queryData, null, null, {maxKeys: 1000}))
                } catch(e) {
                    resolve(null);
                }
            }
        });
    })
}

function new_token(len) {
    var token = crypto.randomBytes(len).toString("hex");
    return token;
}

function cookie_expire(timeStamp) {
    var dayWeekList = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var monthList = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    var _DayOfWeek = dayWeekList[new Date(timeStamp).getDay()];
    var _Day = new Date(timeStamp).getDate();
    var _Month = monthList[new Date(timeStamp).getMonth()];
    var _Year = new Date(timeStamp).getFullYear();
    var _Hour = new Date(timeStamp).getHours();
    var _Minute = new Date(timeStamp).getMinutes();
    var _Second = new Date(timeStamp).getSeconds();

    var compile = _DayOfWeek + ", " + _Day + " " + _Month + " " + _Year + " " + _Hour + ":" + _Minute + ":" + _Second + " UTC";
    return compile
}

function encode_base64(str) {
    return new Buffer(str).toString("base64")
}
function decode_base64(b64str) {
    return new Buffer(b64str, "base64").toString("ascii")
}

var https_reference = https;
var prev_cS = http.createServer;

var options = {};

try { // so that ~FP can run it on his own (since he does not have the keys)
    var options = {
        key: fs.readFileSync("../le/etc/live/nwot.sytes.net/privkey.pem"),
        cert: fs.readFileSync("../le/etc/live/nwot.sytes.net/cert.pem"),
        ca: fs.readFileSync("../le/etc/live/nwot.sytes.net/chain.pem")
    };
} catch(e) { // incase the keys are not available (if running on FPs machine)
    console.log("Running server in HTTP mode")
	http.createServer = function(opt, func) {
        return prev_cS(func);
    }
    https_reference = http
}

function process_error_arg(e) {
    var error = {};
    var keys = Object.getOwnPropertyNames(e);
    for(var i = 0; i < keys.length; i++) {
        error[keys[i]] = e[keys[i]];
    }
    return error;
}

async function get_user_info(cookies, is_websocket) {
    /*
        User Levels:
        3: Superuser (Operator)
        2: Superuser
        1: Staff
        0: regular user
    */
    var user = {
        authenticated: false,
        username: "",
        id: 0,
        csrftoken: null,
        operator: false,
        superuser: false,
        staff: false,
        scripts: []
    }
    if(cookies.sessionid) {
        // user data from session
        var s_data = await db.get("SELECT * FROM auth_session WHERE session_key=?", 
            cookies.sessionid);
        if(s_data) {
            user = JSON.parse(s_data.session_data);
            if(cookies.csrftoken == user.csrftoken) { // verify csrftoken
                user.authenticated = true;
                var level = (await db.get("SELECT level FROM auth_user WHERE id=?",
                user.id)).level

                var operator = level == 3;
                var superuser = level == 2;
                var staff = level == 1;

                user.operator = operator
                user.superuser = superuser || operator
                user.staff = staff || superuser || operator

                if(user.staff && !is_websocket) {
                    user.scripts = await db.all("SELECT * FROM scripts WHERE owner_id=? AND enabled=1", user.id)
                } else {
                    user.scripts = [];
                }
            }
        }
    }
    return user;
}

function plural(int) {
    var p = "";
    if(int != 1) {
        p = "s";
    }
    return p;
}

async function world_get_or_create(name) {
    name += "";
    if(typeof name != "string") name = "";
    var world = await db.get("SELECT * FROM world WHERE name=? COLLATE NOCASE", name);
    if(!world) { // world doesn't exist
        if(name.match(/^(\w*)$/g)) {
            var date = Date.now();
            await db.run("INSERT INTO world VALUES(null, ?, null, ?, 2, 0, 2, 0, 0, '', '', '', '', '', '', 0, 0, '{}')",
                [name, date])
            world = await db.get("SELECT * FROM world WHERE name=? COLLATE NOCASE", name)
        } else { // special worlds (like: /beta/test) are not found and must not be created
            return false;
        }
    }
    return world;
}

async function can_view_world(world, user) {
    var permissions = {
        member: false,
        owner: false,
        can_write: false,
        access_denied: false // superusers can access private worlds (but not write)
    };

    var is_owner = world.owner_id == user.id;
    var superuser = user.superuser;

    if(world.readability == 2 && !is_owner) { // owner only
        permissions.access_denied = true;
        if(!superuser) return false;
    }

    var is_member = await db.get("SELECT * FROM whitelist WHERE world_id=? AND user_id=?",
        [world.id, user.id])

    // members (and owners) only
    if(world.readability == 1 && !is_member && !is_owner) {
        permissions.access_denied = true;
        if(!superuser) return false;
    }

    permissions.member = !!is_member; // !! because is_member is not a boolean
    permissions.owner = is_owner;

    if(is_owner) {
        permissions.member = true;
        // the owner can write by default
        if(is_owner) permissions.can_write = true;
    }

    // the readability and writability both have to be less than 2 for members to write
    if(world.readability < 2 && is_member && world.writability < 2) permissions.can_write = true;

    // anyone can write if anyone can read and write
    if(world.readability == 0 && world.writability == 0) permissions.can_write = true;
    
    return permissions;
}

// from: http://stackoverflow.com/questions/8273047/javascript-function-similar-to-python-range
function xrange(start, stop, step) {
    if (typeof stop == "undefined") {
        stop = start;
        start = 0;
    }
    if (typeof step == "undefined") {
        step = 1;
    }
    if ((step > 0 && start >= stop) || (step < 0 && start <= stop)) {
        return [];
    }
    var result = [];
    for (var i = start; step > 0 ? i < stop : i > stop; i += step) {
        result.push(i);
    }
    return result;
};

function tile_coord(coord) {
    coord = coord.split(",")
    return [parseInt(coord[0]), parseInt(coord[1])];
}

var transaction_active = false;
var is_switching_mode = false; // is the sql engine (asynchronous) finished with switching transaction mode?
var on_switched;
var transaction_req_id = 0;
var req_id = 0;

function transaction_obj(id) {
    var req_id = id;
    var fc = {
        begin: async function(id) {
            if(!transaction_active && !is_switching_mode) {
                transaction_active = true;
                is_switching_mode = true;
                http_s_log.push("[transaction] Started")
                transaction_req_id = req_id;
                await db.run("BEGIN TRANSACTION")
                is_switching_mode = false;
                if(on_switched) on_switched();
            } else if(is_switching_mode) { // the signal hasn't reached, so wait
                on_switched = function() {
                    on_switched = null;
                    fc.begin(); // now begin after the signal completed
                }
            }
        },
        end: async function() {
            if(transaction_active && !is_switching_mode) {
                transaction_active = false;
                is_switching_mode = true;
                http_s_log.push("[transaction] Ended")
                await db.run("COMMIT")
                is_switching_mode = false;
                if(on_switched) on_switched();
            } else if(is_switching_mode) {
                on_switched = function() {
                    on_switched = null;
                    fc.end();
                }
            }
        }
    }
    return fc;
}

process.on("uncaughtException", function(e) {
    fs.writeFileSync(settings.UNCAUGHT_PATH, JSON.stringify(process_error_arg(e)))
    fs.writeFileSync(settings.REQ_LOG, JSON.stringify(http_s_log, null, 4))
    console.log("Uncaught error:", e);
    process.exit();
});

var start_time = Date.now();
var _time_ago = ["millisecond", "second", "minute", "hour", "day", "month", "year"];
function uptime() {
    // (milliseconds ago)
	var seconds_ago = Date.now() - start_time;
    var _data = _time_ago[0];
    var show_minutes = true; // EG: ... and 20 minutes
    var divided = 1;
	if(seconds_ago >= 30067200000) {
        _data = _time_ago[6];
        divided = 30067200000;
		seconds_ago = Math.floor(seconds_ago / divided);
	} else if(seconds_ago >= 2505600000) {
        _data = _time_ago[5];
        divided = 2505600000;
		seconds_ago = Math.floor(seconds_ago / divided);
	} else if(seconds_ago >= 86400000) {
        _data = _time_ago[4];
        divided = 86400000;
		seconds_ago = Math.floor(seconds_ago / divided);
	} else if(seconds_ago >= 3600000) {
        _data = _time_ago[3];
        divided = 3600000;
		seconds_ago = Math.floor(seconds_ago / divided);
    } else if(seconds_ago >= 60000) {
        _data = _time_ago[2];
        divided = 60000;
        show_minutes = false;
		seconds_ago = Math.floor(seconds_ago / divided);
    } else if(seconds_ago >= 1000) {
        _data = _time_ago[1];
        divided = 1000;
        show_minutes = false;
		seconds_ago = Math.floor(seconds_ago / divided);
	} else {
        show_minutes = false;
    }
	if(seconds_ago !== 1) {
		_data += "s";
    }
    var extra = "";
    if(show_minutes) {
        var difference = Date.now() - start_time;
        difference -= divided;
        if(difference > 0) {
            difference %= divided
            difference = Math.floor(difference / 60000);
            if(difference > 0) {
                extra = " and " + difference + " minute";
                if(difference != 1) extra += "s";
            }
        }
    }
	return seconds_ago + " " + _data + extra;
}

var http_s_log = [];

var server = https_reference.createServer(options, async function(req, res) {
    http_s_log.push("HTTP(S): " + req.url +
        " METHOD: " + req.method + ", TIME: " + Date.now() + " [" + new Date() + "]")
    req_id++;
    var current_req_id = req_id;
    try {
        await process_request(req, res, current_req_id)
    } catch(e) {
        if(transaction_active) {
            if(transaction_req_id == current_req_id) {
                transaction_active = false;
                await db.run("COMMIT");
            }
        }
        res.statusCode = 500;
        res.end(template_data["500.html"]({}))
        var error = process_error_arg(e);
        log_error(JSON.stringify(error));
    }
})

async function process_request(req, res, current_req_id) {
    var URL = url.parse(req.url).pathname;
    if(URL.charAt(0) == "/") {
        URL = URL.substr(1);
    }
    try {
        URL = decodeURIComponent(URL);
    } catch (e) {}

    var request_resolved = false;

    // server will return cookies to the client if it needs to
    var include_cookies = [];

    var transaction = transaction_obj(current_req_id)

    function dispatch(data, status_code, params) {
        if(request_resolved) return; // if request is already sent
        request_resolved = true;
        /* params: {
            cookie: the cookie data
            mime: mime type (ex: text/plain)
            redirect: url to redirect to
            download_file: force browser to download this file as .txt. specifies its name
        } (all optional)*/
        var info = {}
        if(!params) {
            params = {};
        }
        if(typeof params.cookie == "string") {
            include_cookies.push(params.cookie)
        } else if(typeof params.cookie == "object") {
            include_cookies = include_cookies.concat(params.cookie)
        }
        if(include_cookies.length == 1) {
            include_cookies = include_cookies[0];
        }
        if(include_cookies.length > 0) {
            info["Set-Cookie"] = include_cookies;
        }
        if(params.download_file) {
            info["Content-disposition"] = "attachment; filename=" + params.download_file;
        }
        if(Math.floor(status_code / 100) * 100 == 300 || params.redirect !== void 0) { // 3xx status code
            if(params.redirect) {
                if(!status_code) {
                    status_code = 302;
                }
                info.Location = params.redirect
            }
        }
        if(params.mime) {
            info["Content-Type"] = params.mime;
        }
        if(!status_code) {
            status_code = 200;
        }
        res.writeHead(status_code, info);
        if(!data) {
            data = "";
        }
        res.write(data, "utf8")
        res.end()
    }

    var vars = {};
    var vars_joined = false; // is already joined with global_data?

    var found_url = false;
    for(var i in url_regexp) {
        var row = url_regexp[i];
        if(URL.match(row[0])) {
            found_url = true;
            if(typeof row[1] == "object") {
                var method = req.method.toUpperCase();
                var post_data = {};
                var query_data = querystring.parse(url.parse(req.url).query)
                var cookies = parseCookie(req.headers.cookie);
                var user = await get_user_info(cookies);
                // check if user is logged in
                if(!cookies.csrftoken) {
                    var token = new_token(32)
                    var date = Date.now();
                    include_cookies.push("csrftoken=" + token + "; expires=" + cookie_expire(date + Year) + "; path=/;")
                    user.csrftoken = token;
                } else {
                    user.csrftoken = cookies.csrftoken;
                }
                var redirected = false;
                function redirect(path) {
                    dispatch(null, null, {
                        redirect: path
                    })
                    redirected = true;
                }
                if(redirected) {
                    return;
                }
                if(method == "POST") {
                    var error = false;
                    var queryData = "";
                    var dat = await wait_response_data(req, dispatch)
                    if(!dat) {
                        return;
                    }
                    post_data = dat;
                }
                vars = objIncludes(global_data, { // extra information
                    cookies,
                    post_data,
                    query_data,
                    path: URL,
                    user,
                    redirect,
                    referer: req.headers.referer,
                    transaction,
                    broadcast: global_data.ws_broadcast
                })
                vars_joined = true;
                if(row[1][method]) {
                    // Return the page
                    await row[1][method](req, dispatch, vars, {})
                } else {
                    dispatch("Method " + method + " not allowed.", 405)
                }
            } else if(typeof row[1] == "string") { // it's a path and must be redirected to
                dispatch(null, null, { redirect: row[1] })
            } else {
                found_url = false; // nevermind, it's not found because the type is invalid
            }
            break;
        }
    }
    if(!vars.user) vars.user = await get_user_info(parseCookie(req.headers.cookie))
    if(!vars.cookies) vars.cookie = parseCookie(req.headers.cookie);
    if(!vars.path) vars.path = URL;

    if(!vars_joined) {
        vars = objIncludes(global_data, vars)
        vars_joined = true
    }

    if(!found_url || !request_resolved) {
        return dispage("404", null, req, dispatch, vars)
    }
}

async function MODIFY_ANNOUNCEMENT(text) {
    if(!text) text = "";
    text += "";
    announcement_cache = text;

    var element = await db.get("SELECT value FROM server_info WHERE name='announcement'");
    if(!element) {
        await db.run("INSERT INTO server_info values('announcement', ?)", text);
    } else {
        await db.run("UPDATE server_info SET value=? WHERE name='announcement'", text)
    }
    ws_broadcast({
        kind: "announcement",
        text: text
    })
}

function announce(text) {
    (async function() {
        await MODIFY_ANNOUNCEMENT(text);
        console.log("Updated announcement");
    })();
}

function start_server() {
    (async function() {
        announcement_cache = await db.get("SELECT value FROM server_info WHERE name='announcement'");
        if(!announcement_cache) {
            announcement_cache = "";
        } else {
            announcement_cache = announcement_cache.value;
        }
    })();

    var wss = new ws.Server({ server });
    ws_broadcast = function(data, world) {
        data = JSON.stringify(data)
        http_s_log.push("[ws] Begin broadcast client, data size is " + data.length)
        wss.clients.forEach(function each(client) {
            try {
                if(client.readyState == ws.OPEN &&
                world == void 0 || toUpper(client.world_name) == toUpper(world)) {
                    client.send(data);
                }
            } catch(e) {
                http_s_log.push("[ws] BROADCAST ERROR: " + JSON.stringify(process_error_arg(e)))
            }
        });
        http_s_log.push("[ws] Finish broadcast client")
    };

    tile_signal_update = function(world, x, y, content, properties, writability) {
        ws_broadcast({
            source: "signal",
            kind: "tileUpdate",
            tiles: {
                [y + "," + x]: {
                    content,
                    properties: Object.assign(properties, { writability })
                }
            }
        }, world)
    };

    global_data.ws_broadcast = ws_broadcast;
    global_data.tile_signal_update = tile_signal_update;

    (async function clear_expired_sessions() {
        // clear expires sessions
        await db.run("DELETE FROM auth_session WHERE expire_date <= ?", Date.now());

        // clear expired registration keys (and accounts that aren't activated yet)
        await db.each("SELECT id FROM auth_user WHERE is_active=0 AND ? - date_joined >= ?",
            [Date.now(), Day * settings.activation_key_days_expire], async function(data) {
            var id = data.id;
            await db.run("DELETE FROM registration_registrationprofile WHERE user_id=?", id);
            await db.run("DELETE FROM auth_user WHERE id=?", id)
        })

        setTimeout(clear_expired_sessions, Minute);
    })();

    server.listen(settings.port, function() {
        var addr = server.address();
        console.log("Server is running.\nAddress: " + addr.address + "\nPort: " + addr.port);

        // start listening for commands
        command_prompt();
    });
    
    wss.on("connection", async function (ws, req) {
        http_s_log.push("[ws] Creating a websocket connection...")
        try {
            var pre_queue = [];
            // code isn't ready yet, so push data to array and then send after it's ready
            function onMessage(msg) {
                pre_queue.push(msg);
            }
            ws.on("message", function(msg) {
                onMessage(msg);
            });
            var location = url.parse(req.url).pathname;
            var world_name;
            function send_ws(data) {
                if(ws.readyState === ws.OPEN) {
                    http_s_log.push("[ws] Sending data with length of " + data.length)
                    ws.send(data);
                    http_s_log.push("[ws] Data sending complete")
                }
            }
            if(location.match(/(\/ws\/$)/)) {
                world_name = location.replace(/(^\/)|(\/ws\/)|(ws\/$)/g, "");
            } else {
                send_ws(JSON.stringify({
                    kind: "error",
                    message: "Invalid address"
                }));
                return ws.close();
            }
            ws.world_name = world_name;
            var cookies = parseCookie(req.headers.cookie);
            var user = await get_user_info(cookies, true)
            var channel = new_token(16);
            var vars = objIncludes(global_data, {
                user,
                channel
            })
            var status = await websockets.Main(ws, world_name, vars);
            if(typeof status == "string") {
                send_ws(JSON.stringify({
                    kind: "error",
                    message: status
                }));
                return ws.close();
            }
            vars.world = status.world;
            vars.timemachine = status.timemachine

            user.stats = status.permission;
            send_ws(JSON.stringify({
                kind: "channel",
                sender: channel
            }))
            ws.on("error", function(err) {
                http_s_log.push("[ws] An error occured: " + err);
                log_error(JSON.stringify(process_error_arg(err)));
            });
			var verified = false;
			verify = function() {
				verified = true;
			}.bind(this);
			var vercode = websockets.verify.generate();
			var key = vercode[0];
			send_ws(JSON.stringify({
				kind: "verfy",
				dat4: vercode[1];
			}));
            onMessage = async function(msg) {
                http_s_log.push("[ws] Received message event with length of " + msg.length)
                req_id++;
                var current_req_id = req_id;
                try {
                    if(msg == "2::") {
                        return send_ws(JSON.stringify({
                            kind: "ping",
                            result: "pong"
                        }));
                    }
                    try {
                        msg = JSON.parse(msg);
                    } catch(e) {
                        send_ws('{"kind":"error","message":"418 I\'m a Teapot"}');
                        return ws.close()
                    }
                    var kind = msg.kind;
					if(websockets[kind]) {
                        function send(msg) {
                            msg.kind = kind
                            send_ws(JSON.stringify(msg))
                        }
                        function broadcast(data) {
                            data.source = kind;
                            ws_broadcast(data, world_name);
                        }
						if (verified || (kind == "verify")) {
							var res = await websockets[kind](ws, msg, send, objIncludes(vars, {
								transaction: transaction_obj(current_req_id),
								broadcast, verify, key
							}))
							if(typeof res == "string") {
								send_ws(JSON.stringify({
									kind: "error",
									message: res
								}));
							}
						}
                    }
                } catch(e) {
                    handle_ws_error(e);
                }
            }
            if(pre_queue.length > 0) {
                for(var p = 0; p < pre_queue.length; p++) {
                    onMessage(pre_queue[0]);
                    pre_queue.splice(p, 1)
                }
            }
        } catch(e) {
            handle_ws_error(e);
        }
    })
}

function handle_ws_error(e) {
    log_error(JSON.stringify(process_error_arg(e)));
}

var global_data = {
    template_data,
    db,
    dispage,
    ms,
    cookie_expire,
    checkHash,
    encryptHash,
    new_token,
    querystring,
    url,
    split_limit,
    website: settings.website,
    send_email,
    crypto,
    filename_sanitize,
    get_third,
    create_date,
    get_user_info,
    world_get_or_create,
    can_view_world,
    san_nbr,
    xrange,
    tile_coord,
    modules,
    plural,
    announcement: function() { return announcement_cache },
    announce: MODIFY_ANNOUNCEMENT,
    uptime
}

function stopServer() {
	process.exit(0);
}