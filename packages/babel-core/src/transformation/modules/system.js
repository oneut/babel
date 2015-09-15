import DefaultFormatter from "./_default";
import AMDFormatter from "./amd";
import * as util from  "../../util";
import last from "lodash/array/last";
import map from "lodash/collection/map";
import * as t from "babel-types";

var hoistVariablesVisitor = {
  Function(path) {
    // nothing inside is accessible
    path.skip();
  },

  VariableDeclaration({ node, parent }, state) {
    if (node.kind !== "var" && !t.isProgram(parent)) { // let, const
      // can't be accessed
      return;
    }

    // ignore block hoisted nodes as these can be left in
    if (state.formatter._canHoist(node)) return;

    var nodes = [];

    for (var i = 0; i < node.declarations.length; i++) {
      var declar = node.declarations[i];
      state.hoistDeclarators.push(t.variableDeclarator(declar.id));
      if (declar.init) {
        // no initializer so we can just hoist it as-is
        var assign = t.expressionStatement(t.assignmentExpression("=", declar.id, declar.init));
        nodes.push(assign);
      }
    }

    // for (var i in test)
    if (t.isFor(parent) && parent.left === node) {
      return node.declarations[0].id;
    }

    return nodes;
  }
};

var hoistFunctionsVisitor = {
  Function(path) {
    path.skip();
  },

  enter(path, state) {
    if (path.isFunctionDeclaration() || state.formatter._canHoist(path.node)) {
      state.handlerBody.push(path.node);
      path.remove();
    }
  }
};

var runnerSettersVisitor = {
  enter(path, state) {
    var { node } = path;

    if (node._importSource === state.source) {
      if (t.isVariableDeclaration(node)) {
        for (var declar of (node.declarations: Array)) {
          state.hoistDeclarators.push(t.variableDeclarator(declar.id));
          state.nodes.push(t.expressionStatement(
            t.assignmentExpression("=", declar.id, declar.init)
          ));
        }
      } else {
        state.nodes.push(node);
      }

      path.remove();
    }
  }
};

export default class SystemFormatter extends AMDFormatter {
  constructor(file) {
    super(file);

    this._setters = null;
    this.exportIdentifier = file.scope.generateUidIdentifier("export");
    this.noInteropRequireExport = true;
    this.noInteropRequireImport = true;

    this.remaps.clearAll();
  }

  _addImportSource(node, exportNode) {
    if (node) node._importSource = exportNode.source && exportNode.source.value;
    return node;
  }

  buildExportsWildcard(objectIdentifier, node) {
    var leftIdentifier = this.scope.generateUidIdentifier("key");
    var valIdentifier  = t.memberExpression(objectIdentifier, leftIdentifier, true);

    var left = t.variableDeclaration("var", [
      t.variableDeclarator(leftIdentifier)
    ]);

    var right = objectIdentifier;

    var block = t.blockStatement([
      t.ifStatement(
        t.binaryExpression("!==", leftIdentifier, t.stringLiteral("default")),
        t.expressionStatement(this._buildExportCall(leftIdentifier, valIdentifier))
      )
    ]);

    return this._addImportSource(t.forInStatement(left, right, block), node);
  }

  buildExportsAssignment(id, init, node) {
    var call = this._buildExportCall(t.stringLiteral(id.name), init, true);
    return this._addImportSource(call, node);
  }

  buildExportsFromAssignment() {
    return this.buildExportsAssignment(...arguments);
  }

  remapExportAssignment(node, exported) {
    var assign = node;

    for (var i = 0; i < exported.length; i++) {
      assign = this._buildExportCall(t.stringLiteral(exported[i].name), assign);
    }

    return assign;
  }

  _buildExportCall(id, init, isStatement) {
    var call = t.callExpression(this.exportIdentifier, [id, init]);
    if (isStatement) {
      return t.expressionStatement(call);
    } else {
      return call;
    }
  }

  importSpecifier(specifier, node, nodes) {
    AMDFormatter.prototype.importSpecifier.apply(this, arguments);

    for (var remap of (this.remaps.getAll(): Array)) {
      nodes.push(t.variableDeclaration("var", [
        t.variableDeclarator(t.identifier(remap.name), remap.node)
      ]));
    }

    this.remaps.clearAll();

    this._addImportSource(last(nodes), node);
  }

  _buildRunnerSetters(block, hoistDeclarators) {
    var scope = this.file.scope;

    return t.arrayExpression(map(this.ids, function (uid, source) {
      var state = {
        hoistDeclarators: hoistDeclarators,
        source:           source,
        nodes:            []
      };

      scope.traverse(block, runnerSettersVisitor, state);

      return t.functionExpression(null, [uid], t.blockStatement(state.nodes));
    }));
  }

  _canHoist(node) {
    return node._blockHoist && !this.file.dynamicImports.length;
  }

  transform(program) {
    DefaultFormatter.prototype.transform.apply(this, arguments);

    var hoistDeclarators = [];
    var moduleName = this.getModuleName();
    var moduleNameLiteral = t.stringLiteral(moduleName);

    var block = t.blockStatement(program.body);

    var setterListNode = this._buildRunnerSetters(block, hoistDeclarators);
    this._setters = setterListNode;

    var runner = util.template("system", {
      MODULE_DEPENDENCIES: t.arrayExpression(this.buildDependencyLiterals()),
      EXPORT_IDENTIFIER:   this.exportIdentifier,
      MODULE_NAME:         moduleNameLiteral,
      SETTERS:             setterListNode,
      EXECUTE:             t.functionExpression(null, [], block)
    }, true);

    var handlerBody = runner.expression.arguments[2].body.body;
    if (!moduleName) runner.expression.arguments.shift();

    var returnStatement = handlerBody.pop();

    // hoist up all variable declarations
    this.file.scope.traverse(block, hoistVariablesVisitor, {
      formatter: this,
      hoistDeclarators: hoistDeclarators
    });

    if (hoistDeclarators.length) {
      var hoistDeclar = t.variableDeclaration("var", hoistDeclarators);
      hoistDeclar._blockHoist = true;
      handlerBody.unshift(hoistDeclar);
    }

    // hoist up function declarations for circular references
    this.file.scope.traverse(block, hoistFunctionsVisitor, {
      formatter: this,
      handlerBody: handlerBody
    });

    handlerBody.push(returnStatement);

    program.body = [runner];
  }
}