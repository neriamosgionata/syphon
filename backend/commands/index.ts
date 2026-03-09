import { listDirectoryFiles } from '@adonisjs/core/build/standalone'

export default listDirectoryFiles(__dirname, './', ['.ts'])
