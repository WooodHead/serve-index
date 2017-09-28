/*!
 * serve-index
 * Copyright(c) 2011 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts');
var createError = require('http-errors');
var debug = require('debug')('serve-index');
var escapeHtml = require('escape-html');
var fs = require('fs'),
  path = require('path'),
  normalize = path.normalize,
  sep = path.sep,
  extname = path.extname,
  join = path.join;
var Batch = require('batch');
var mime = require('mime-types');
var parseUrl = require('parseurl');
var resolve = require('path').resolve;

/**
 * Module exports.
 * @public
 */

module.exports = serveIndex;

/*!
 * Icon cache.
 */

var cache = {};

/*!
 * Default template.
 */

var defaultTemplate = join(__dirname, 'public', 'directory.html');

/*!
 * Stylesheet.
 */

var defaultStylesheet = join(__dirname, 'public', 'style.css');

/**
 * Media types and the map for content negotiation.
 */

var mediaTypes = [
  'text/html',
  'text/plain',
  'application/json'
];

var mediaType = {
  'text/html': 'html',
  'text/plain': 'plain',
  'application/json': 'json'
};



function serveIndex(root, options) {
  var opts = options || {};

  // root required
  if (!root) {
    throw new TypeError('serveIndex() root path required');
  }

  // resolve root to absolute and normalize
  var rootPath = normalize(resolve(root) + sep);

  var filter = opts.filter;
  var hidden = opts.hidden;
  var icons = opts.icons;
  var stylesheet = opts.stylesheet || defaultStylesheet;
  var template = opts.template || defaultTemplate;
  var view = opts.view || 'tiles';

  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 'OPTIONS' === req.method ? 200 : 405;
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    // parse URLs
    var url = parseUrl(req);
    var originalUrl = parseUrl.original(req);
    var dir = decodeURIComponent(url.pathname);
    var originalDir = decodeURIComponent(originalUrl.pathname);

    // join / normalize from root dir
    var path = normalize(join(rootPath, dir));

    // null byte(s), bad request
    if (~path.indexOf('\0')) return next(createError(400));

    // malicious path
    if ((path + sep).substr(0, rootPath.length) !== rootPath) {
      debug('malicious path "%s"', path);
      return next(createError(403));
    }

    // determine ".." display
    var showUp = normalize(resolve(path) + sep) !== rootPath;

    // check if we have a directory
    debug('stat "%s"', path);
    fs.stat(path, function (err, stat) {
      if (err && err.code === 'ENOENT') {
        return next();
      }

      if (err) {
        err.status = err.code === 'ENAMETOOLONG' ?
          414 :
          500;
        return next(err);
      }

      if (!stat.isDirectory()) return next();

      // fetch files
      debug('readdir "%s"', path);
      fs.readdir(path, function (err, files) {
        if (err) return next(err);

        files.sort();

        // content-negotiation
        var accept = accepts(req);
        var type = accept.type(mediaTypes);

        // not acceptable
        if (!type) return next(createError(406));
        serveIndex[mediaType[type]](req, res, files, next, originalDir, showUp, icons, path, view, template, stylesheet);
      });
    });
  };
};

/**
 * Respond with text/html.
 */

serveIndex.html = function _html(req, res, files, next, dir, showUp, icons, path, view, template, stylesheet) {
  var render = typeof template !== 'function' ?
    createHtmlRender(template) :
    template

  if (showUp) {
    files.unshift('..');
  }

  // stat all files
  stat(path, files, function (err, stats) {
    if (err) return next(err);

    // combine the stats into the file list
    var fileList = files.map(function (file, i) {
      return {
        name: file,
        stat: stats[i]
      };
    });

    // read stylesheet
    fs.readFile(stylesheet, 'utf8', function (err, style) {
      if (err) return next(err);

      // create locals for rendering
      var locals = {
        directory: dir,
        displayIcons: Boolean(icons),
        fileList: fileList,
        path: path,
        style: style,
        viewName: view
      };

      // render html
      render(locals, function (err, body) {
        if (err) return next(err);
        send(res, 'text/html', body)
      });
    });
  });
};

/**
 * Respond with application/json.
 */

serveIndex.json = function _json(req, res, files) {
  send(res, 'application/json', JSON.stringify(files))
};

/**
 * Respond with text/plain.
 */

serveIndex.plain = function _plain(req, res, files) {
  send(res, 'text/plain', (files.join('\n') + '\n'))
};

/**
 * Map html `files`, returning an html unordered list.
 * @private
 */

function createHtmlFileList(files, dir, useIcons, view) {
  var html = '<ul id="files" class="view-' + escapeHtml(view) + '">' +
    (view == 'details' ? (
      '<li class="header">' +
      '<span class="name">Name</span>' +
      '<span class="size">Size</span>' +
      '<span class="date">Modified</span>' +
      '</li>') : '');

  html += files.map(function (file) {
    var classes = [];
    var isDir = file.stat && file.stat.isDirectory();
    var path = dir.split('/').map(function (c) {
      return encodeURIComponent(c);
    });

    if (useIcons) {
      classes.push('icon');
    }

    path.push(encodeURIComponent(file.name));

    var date = file.stat && file.name !== '..' ?
      file.stat.mtime.toLocaleDateString() + ' ' + file.stat.mtime.toLocaleTimeString() :
      '';
    var size = file.stat && !isDir ?
      file.stat.size :
      '';

    var href = escapeHtml(normalizeSlashes(normalize(path.join('/'))));

    var result = '<li><a href="' + href +
      '" class="' + escapeHtml(classes.join(' ')) + '"' +
      ' title="' + escapeHtml(file.name) + '">' +
      '<span class="name">' + escapeHtml(file.name) + '</span>' +
      '<span class="size">' + escapeHtml(size) + '</span>' +
      '<span class="date">' + escapeHtml(date) + '</span>' +
      '</a></li>';

    var ext = extname(file.name);
    if (ext === '.mp4' && !isDir) {
      result += '<div class="video-wrap"><video id="my_video_1" class="video-js vjs-default-skin" controls preload="auto" ' +
        'data-setup=\'{ "playbackRates": [0.5, 1, 1.5, 2], aspectRatio:"16:9" }\'>' +
        '<source src="' + href + '" type=\'video/mp4\'>' +
        '</video></div>'

    }

    return result;


  }).join('\n');

  html += '</ul>';

  return html;
}

/**
 * Create function to render html.
 */

function createHtmlRender(template) {
  return function render(locals, callback) {
    // read template
    fs.readFile(template, 'utf8', function (err, str) {
      if (err) return callback(err);

      var body = str
        .replace(/\{style\}/g, locals.style.concat(iconStyle(locals.fileList, locals.displayIcons)))
        .replace(/\{files\}/g, createHtmlFileList(locals.fileList, locals.directory, locals.displayIcons, locals.viewName))
        .replace(/\{directory\}/g, escapeHtml(locals.directory))
        .replace(/\{linked-path\}/g, htmlPath(locals.directory));

      callback(null, body);
    });
  };
}


/**
 * Map html `dir`, returning a linked path.
 */

function htmlPath(dir) {
  var parts = dir.split('/');
  var crumb = new Array(parts.length);

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumb[i] = '<a href="' + escapeHtml(parts.slice(0, i + 1).join('/')) + '">' + escapeHtml(part) + '</a>';
    }
  }

  return crumb.join(' / ');
}

function iconLookup(filename) {

  return {
    className: 'icon-default',
    fileName: icons.default
  };
}


function iconStyle(files, useIcons) {
  var style = '';

  return style;
}


function load(icon) {
  if (cache[icon]) return cache[icon];
  return cache[icon] = fs.readFileSync(__dirname + '/public/icons/' + icon, 'base64');
}


function normalizeSlashes(path) {
  return path.split(sep).join('/');
};



function send(res, type, body) {
  // security header for content sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // standard headers
  res.setHeader('Content-Type', type + '; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))

  // body
  res.end(body, 'utf8')
}

/**
 * Stat all files and return array of stat
 * in same order.
 */

function stat(dir, files, cb) {
  var batch = new Batch();

  batch.concurrency(10);

  files.forEach(function (file) {
    batch.push(function (done) {
      fs.stat(join(dir, file), function (err, stat) {
        if (err && err.code !== 'ENOENT') return done(err);

        // pass ENOENT as null stat, not error
        done(null, stat || null);
      });
    });
  });

  batch.end(cb);
}